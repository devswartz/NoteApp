//! Quick add: reading "Send invoice tomorrow p1 @sam every month #waiting +elders" into a title
//! and fields. Today's web app does this on the client (`shared/quickadd.ts`, called by
//! `src/components/QuickAdd.tsx` and the subtask field), so it is ported here with the same
//! rules in the same order; `tests/corpus/quickadd.json` (made by running the web's parser,
//! `scripts/corpus/quickadd.ts`) is the contract.
//!
//! Offsets in `tokens` are UTF-16 code units, as the web's are (Swift's `String.utf16` and
//! `NSRange` use them).

use std::sync::OnceLock;

use nv_api::Recurrence;
use regex::Regex;

use crate::recurrence::{
    civil, days_from, first_occurrence_of, fmt, is_iso_date, js_regex, parse, parse_recurrence,
    weekday_of_days,
};
use crate::task_detail::TaskRecurrence;

/// What kind of text a token is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum QuickAddKind {
    Date,
    Time,
    Priority,
    Recurrence,
    Assignee,
    Tag,
    Team,
}

/// A recognised span of the input (for highlighting).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct QuickAddToken {
    /// UTF-16 offsets into the input: `[start, end)`.
    pub start: u32,
    pub end: u32,
    pub kind: QuickAddKind,
}

/// The parse of a quick-add line (`QuickAddResult` in shared/quickadd.ts).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct QuickAddResult {
    /// The input without the recognised words, spaces collapsed.
    pub title: String,
    /// Local date, YYYY-MM-DD.
    pub due_date: Option<String>,
    /// Local time, HH:mm.
    pub due_time: Option<String>,
    /// 1 urgent … 4 none (what `p1` to `p4` say).
    pub priority: Option<u8>,
    pub recurrence: Option<TaskRecurrence>,
    /// The text after "@", for `resolve_member`.
    pub assignee: Option<String>,
    /// The names after "#", once each: look them up (`Core::tags`) or make them (`Core::create_tag`).
    pub tags: Vec<String>,
    /// The text after "+", for `resolve_team`.
    pub team: Option<String>,
    pub tokens: Vec<QuickAddToken>,
}

#[derive(Clone)]
struct Parsed {
    due_date: Option<String>,
    due_time: Option<String>,
    priority: Option<u8>,
    recurrence: Option<Recurrence>,
    assignee: Option<String>,
    tags: Vec<String>,
    team: Option<String>,
    /// Byte ranges.
    tokens: Vec<(usize, usize, QuickAddKind)>,
}

const WEEKDAYS: [&str; 7] = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];
const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAY_RE: &str = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?";
const MONTH_RE: &str = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";

fn add_days(z: i64, n: i64) -> i64 {
    z + n
}

/// `addMonths`: n months on, the day clamped to the target month's length.
fn add_months(z: i64, n: i64) -> i64 {
    let (y, m, d) = civil(z);
    let first = days_from(y, m - 1 + n, 1);
    let (fy, fm, _) = civil(first);
    let last = days_from(fy, fm, 1) - first;
    first + d.min(last) - 1
}

/// `nextWeekday` (strictly after).
fn next_weekday(from: i64, idx: i64) -> i64 {
    let mut diff = (idx - weekday_of_days(from) + 7) % 7;
    if diff == 0 {
        diff = 7;
    }
    add_days(from, diff)
}

/// `monthDay`: that month and day on or after `base`, else next year's; none for a day that
/// the month doesn't have.
fn month_day(month: i64, day: i64, base: i64) -> Option<i64> {
    if !(0..12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (y, _, _) = civil(base);
    let mut d = days_from(y, month, day);
    // `new Date(y, month, day)` rolls an impossible day into the next month: not this month.
    if civil(d).1 - 1 != month {
        return None;
    }
    if d < base {
        // Feb 29 in a year without one rolls to March 1, as `new Date` does.
        d = days_from(y + 1, month, day);
    }
    Some(d)
}

type Apply = fn(&regex::Captures, &mut Parsed, i64) -> bool;

struct Rule {
    re: Regex,
    kind: QuickAddKind,
    apply: Apply,
}

fn rules() -> &'static Vec<Rule> {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| {
        let rule = |src: &str, kind, apply: Apply| Rule {
            re: js_regex(src, true),
            kind,
            apply,
        };
        vec![
            rule(
                r"(?:^|\s)!?p([1-4])\b",
                QuickAddKind::Priority,
                |m, r, _| {
                    r.priority = m[1].parse().ok();
                    true
                },
            ),
            rule(
                r"(?:^|\s)@([\p{L}\p{N}._-]+)",
                QuickAddKind::Assignee,
                |m, r, _| {
                    r.assignee = Some(m[1].to_string());
                    true
                },
            ),
            rule(
                r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b",
                QuickAddKind::Time,
                |m, r, base| {
                    let (h, min): (i64, i64) = if let Some(ap) = m.get(3) {
                        let h: i64 = m[1].parse().unwrap_or(0);
                        let pm = ap.as_str().eq_ignore_ascii_case("pm");
                        (
                            h % 12 + if pm { 12 } else { 0 },
                            m.get(2).map_or(0, |x| x.as_str().parse().unwrap_or(0)),
                        )
                    } else {
                        (m[4].parse().unwrap_or(0), m[5].parse().unwrap_or(0))
                    };
                    if h > 23 || min > 59 {
                        return false;
                    }
                    r.due_time = Some(format!("{h:02}:{min:02}"));
                    r.due_date.get_or_insert_with(|| fmt(base));
                    true
                },
            ),
            rule(
                r"\b(?:at\s+)?(noon|midday|midnight)\b",
                QuickAddKind::Time,
                |m, r, base| {
                    r.due_time = Some(
                        if m[1].eq_ignore_ascii_case("midnight") {
                            "00:00"
                        } else {
                            "12:00"
                        }
                        .into(),
                    );
                    r.due_date.get_or_insert_with(|| fmt(base));
                    true
                },
            ),
            rule(
                r"\b(today|tod|tonight)\b",
                QuickAddKind::Date,
                |_, r, base| {
                    r.due_date = Some(fmt(base));
                    true
                },
            ),
            rule(
                r"\b(tomorrow|tmr|tmrw)\b",
                QuickAddKind::Date,
                |_, r, base| {
                    r.due_date = Some(fmt(add_days(base, 1)));
                    true
                },
            ),
            rule(r"\bnext\s+week\b", QuickAddKind::Date, |_, r, base| {
                r.due_date = Some(fmt(next_weekday(base, 1)));
                true
            }),
            rule(r"\bnext\s+month\b", QuickAddKind::Date, |_, r, base| {
                let (y, m, _) = civil(add_months(base, 1));
                r.due_date = Some(fmt(days_from(y, m - 1, 1)));
                true
            }),
            rule(
                r"\bin\s+(\d+)\s+(day|days|week|weeks|month|months)\b",
                QuickAddKind::Date,
                |m, r, base| {
                    let n: i64 = m[1].parse().unwrap_or(i64::MAX / 4);
                    let d = match m[2].to_lowercase().as_str() {
                        "day" | "days" => add_days(base, n),
                        "week" | "weeks" => add_days(base, n.saturating_mul(7)),
                        _ => add_months(base, n),
                    };
                    r.due_date = Some(fmt(d));
                    true
                },
            ),
            rule(
                r"\b(\d{4})-(\d{2})-(\d{2})\b",
                QuickAddKind::Date,
                |m, r, _| {
                    let (mut y, mo, d): (i64, i64, i64) = (
                        m[1].parse().unwrap_or(0),
                        m[2].parse().unwrap_or(0),
                        m[3].parse().unwrap_or(0),
                    );
                    // `new Date(y, …)` reads a year 0 to 99 as 1900 to 1999.
                    if (0..100).contains(&y) {
                        y += 1900;
                    }
                    let z = days_from(y, mo - 1, d);
                    if civil(z).1 != mo {
                        return false;
                    }
                    r.due_date = Some(fmt(z));
                    true
                },
            ),
            rule(
                &format!(r"\b(?:on\s+)?{MONTH_RE}\s+(\d{{1,2}})(?:st|nd|rd|th)?\b"),
                QuickAddKind::Date,
                |m, r, base| {
                    let mi = month_index(&m[1]);
                    match month_day(mi, m[2].parse().unwrap_or(0), base) {
                        Some(d) => {
                            r.due_date = Some(fmt(d));
                            true
                        }
                        None => false,
                    }
                },
            ),
            rule(
                &format!(r"\b(?:on\s+)?(\d{{1,2}})(?:st|nd|rd|th)?\s+{MONTH_RE}\b"),
                QuickAddKind::Date,
                |m, r, base| {
                    let mi = month_index(&m[2]);
                    match month_day(mi, m[1].parse().unwrap_or(0), base) {
                        Some(d) => {
                            r.due_date = Some(fmt(d));
                            true
                        }
                        None => false,
                    }
                },
            ),
            rule(
                &format!(r"\b(?:on\s+|next\s+)?{WEEKDAY_RE}\b"),
                QuickAddKind::Date,
                |m, r, base| {
                    let w = m[1].to_lowercase();
                    let Some(idx) = w
                        .get(..3)
                        .and_then(|k| WEEKDAYS.iter().position(|d| d.starts_with(k)))
                    else {
                        return false;
                    };
                    r.due_date = Some(fmt(next_weekday(base, idx as i64)));
                    true
                },
            ),
        ]
    })
}

fn month_index(m: &str) -> i64 {
    let w = m.to_lowercase();
    w.get(..3)
        .and_then(|k| MONTHS.iter().position(|x| *x == k))
        .map_or(-1, |i| i as i64)
}

fn utf16(s: &str, byte: usize) -> u32 {
    s[..byte].encode_utf16().count() as u32
}

/// Read a quick-add line. `today` is the caller's local date, `YYYY-MM-DD` (a date the words
/// "tomorrow", "friday" and so on count from); anything else counts as today in UTC.
pub(crate) fn parse_quick_add(input: &str, today: &str) -> QuickAddResult {
    let base = parse(today).unwrap_or_else(|| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        secs.div_euclid(86_400)
    });
    let base_s = fmt(base);
    let mut r = Parsed {
        due_date: None,
        due_time: None,
        priority: None,
        recurrence: None,
        assignee: None,
        tags: Vec::new(),
        team: None,
        tokens: Vec::new(),
    };
    // Consumed bytes, so rules don't overlap.
    let mut consumed = vec![false; input.len()];
    let mut seen: Vec<QuickAddKind> = Vec::new();
    // Recurrence first, so "every monday" isn't eaten by the date rules.
    if let Some(rec) = parse_recurrence(input) {
        r.recurrence = Some(rec.rule);
        consumed[rec.start..rec.end].fill(true);
        r.tokens
            .push((rec.start, rec.end, QuickAddKind::Recurrence));
        seen.push(QuickAddKind::Recurrence);
    }
    static LEAD: OnceLock<Regex> = OnceLock::new();
    let lead_re = LEAD.get_or_init(|| js_regex(r"(?:^|\s)((?:by|due|on|at)\s+)$", true));
    for rule in rules() {
        // One match per kind: the first rule that matches wins.
        if seen.contains(&rule.kind) {
            continue;
        }
        for m in rule.re.captures_iter(input) {
            let whole = m.get(0).expect("group 0");
            let mut start = whole.start();
            let end = whole.end();
            while start < end {
                let c = input[start..].chars().next().expect("a char");
                if !c.is_whitespace() {
                    break;
                }
                start += c.len_utf8();
            }
            if consumed[start..end].iter().any(|&c| c) {
                continue;
            }
            let snapshot = r.clone();
            if (rule.apply)(&m, &mut r, base) {
                // Swallow a dangling connector before a date or time: "Ship by Friday".
                if matches!(rule.kind, QuickAddKind::Date | QuickAddKind::Time) {
                    if let Some(lead) = lead_re.captures(&input[..start]) {
                        let n = lead[1].len();
                        if !consumed[start - n..start].iter().any(|&c| c) {
                            start -= n;
                        }
                    }
                }
                consumed[start..end].fill(true);
                r.tokens.push((start, end, rule.kind));
                seen.push(rule.kind);
                break;
            }
            r = snapshot;
        }
    }
    // #tag (several; starts with a letter, so "#123" stays text) and +team (the first one).
    static TAG: OnceLock<Regex> = OnceLock::new();
    static TEAM: OnceLock<Regex> = OnceLock::new();
    let tag_re = TAG.get_or_init(|| js_regex(r"(^|\s)#(\p{L}[\p{L}\p{N}_-]*)", false));
    let team_re = TEAM.get_or_init(|| js_regex(r"(^|\s)\+(\p{L}[\p{L}\p{N}_-]*)", false));
    for m in tag_re.captures_iter(input) {
        let start = m.get(0).expect("group 0").start() + m[1].len();
        let end = start + 1 + m[2].len();
        if consumed[start..end].iter().any(|&c| c) {
            continue;
        }
        let name = m[2].to_string();
        if !r
            .tags
            .iter()
            .any(|t| t.to_lowercase() == name.to_lowercase())
        {
            r.tags.push(name);
        }
        consumed[start..end].fill(true);
        r.tokens.push((start, end, QuickAddKind::Tag));
    }
    for m in team_re.captures_iter(input) {
        let start = m.get(0).expect("group 0").start() + m[1].len();
        let end = start + 1 + m[2].len();
        if consumed[start..end].iter().any(|&c| c) {
            continue;
        }
        r.team = Some(m[2].to_string());
        consumed[start..end].fill(true);
        r.tokens.push((start, end, QuickAddKind::Team));
        break;
    }
    if let Some(rule) = r.recurrence.as_mut() {
        // No explicit date: start on the first day the rule matches ("every monday" → next Monday).
        let due = r
            .due_date
            .get_or_insert_with(|| first_occurrence_of(rule, &base_s))
            .clone();
        // Pin monthly and yearly rules to the due date's day so month ends don't drift.
        if (rule.freq == "month" || rule.freq == "year")
            && rule.by_month_day.is_none()
            && rule.by_nth_weekday.is_none()
            && is_iso_date(&due)
        {
            rule.by_month_day = due[8..10].parse().ok();
        }
    }
    let spaced: String = input
        .char_indices()
        .map(|(i, c)| if consumed[i] { ' ' } else { c })
        .collect();
    let title = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    r.tokens.sort_by_key(|t| t.0);
    QuickAddResult {
        title,
        due_date: r.due_date,
        due_time: r.due_time,
        priority: r.priority,
        recurrence: r.recurrence.as_ref().map(TaskRecurrence::from),
        assignee: r.assignee,
        tags: r.tags,
        team: r.team,
        tokens: r
            .tokens
            .into_iter()
            .map(|(s, e, kind)| QuickAddToken {
                start: utf16(input, s),
                end: utf16(input, e),
                kind,
            })
            .collect(),
    }
}
