//! Repeat rules: the part of `shared/recurrence.ts` the apps need on the device: the first date
//! of a rule, its description, and reading a rule out of typed text (for quick add). The server
//! rolls a recurring task forward itself when it is ticked, so nothing here runs on completion.
//!
//! Dates are local calendar dates, `YYYY-MM-DD` strings (as the server stores them). The
//! calendar maths is done on days since 1970-01-01, so a time zone never shifts a day, as in
//! the TypeScript (UTC `Date`s). Checked against it by `tests/corpus/quickadd.json`
//! (`scripts/corpus/quickadd.ts`).

use std::sync::OnceLock;

use nv_api::{NthWeekday, Recurrence};
use regex::{Captures, Regex};

// ---------------------------------------------------------------- calendar

/// Days since 1970-01-01 of a civil date (months and days may overflow, as `Date.UTC` allows).
pub(crate) fn days_from(y: i64, m0: i64, d: i64) -> i64 {
    let y = y + m0.div_euclid(12);
    let m = m0.rem_euclid(12) + 1;
    // Howard Hinnant's days_from_civil, for the first of the month; then add the day.
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + d - 1
}

/// (year, month 1..=12, day) of days since 1970-01-01.
pub(crate) fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

pub(crate) fn fmt(z: i64) -> String {
    let (y, m, d) = civil(z);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The days of a strictly written `YYYY-MM-DD` that is a real date (`isISODate`).
pub(crate) fn parse(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (
        s[0..4].parse().ok()?,
        s[5..7].parse().ok()?,
        s[8..10].parse().ok()?,
    );
    let z = days_from(y, m - 1, d);
    (fmt(z) == s).then_some(z)
}

/// `YYYY-MM-DD` that is a real date.
pub(crate) fn is_iso_date(s: &str) -> bool {
    parse(s).is_some()
}

/// 0 Sunday … 6 Saturday.
pub(crate) fn weekday_of_days(z: i64) -> i64 {
    (z + 4).rem_euclid(7)
}

fn days_in_month(y: i64, m0: i64) -> i64 {
    days_from(y, m0 + 1, 1) - days_from(y, m0, 1)
}

/// `monthDay`: day `day` (1 to 31, or -1 for the last) of the month `n` months after `z`'s,
/// clamped to the month's length.
fn month_day(z: i64, n: i64, day: i64) -> i64 {
    let (y, m, _) = civil(z);
    let first = days_from(y, m - 1 + n, 1);
    let (fy, fm, _) = civil(first);
    let last = days_in_month(fy, fm - 1);
    days_from(fy, fm - 1, if day == -1 { last } else { day.min(last) })
}

/// `nthWeekday`: the nth weekday of the month `n` months after `z`'s, if it exists.
fn nth_weekday(z: i64, n: i64, nth: i64, weekday: i64) -> Option<i64> {
    let (y, m, _) = civil(z);
    let first = days_from(y, m - 1 + n, 1);
    let (fy, fm, _) = civil(first);
    let len = days_in_month(fy, fm - 1);
    if nth == -1 {
        let last = days_from(fy, fm - 1, len);
        return Some(last - (weekday_of_days(last) - weekday + 7) % 7);
    }
    let day = 1 + (weekday - weekday_of_days(first) + 7) % 7 + 7 * (nth - 1);
    (day <= len).then(|| days_from(fy, fm - 1, day))
}

fn interval(r: &Recurrence) -> i64 {
    if r.freq == "weekday" {
        1
    } else {
        i64::from(r.interval.unwrap_or(1)).max(1)
    }
}

/// The first occurrence strictly after `d`, keeping `d`'s interval phase (`stepAfter`).
pub(crate) fn step_after(rule: &Recurrence, d: i64) -> i64 {
    let n = interval(rule);
    let (_, _, dom) = civil(d);
    match rule.freq.as_str() {
        "day" => d + n,
        "weekday" => {
            let mut x = d + 1;
            while matches!(weekday_of_days(x), 0 | 6) {
                x += 1;
            }
            x
        }
        "week" => {
            let Some(days) = rule.by_weekday.as_ref().filter(|v| !v.is_empty()) else {
                return d + 7 * n;
            };
            let order = |w: i64| (w + 6) % 7; // Monday 0 … Sunday 6
            let mut sorted: Vec<i64> = Vec::new();
            for &w in days {
                if !sorted.contains(&i64::from(w)) {
                    sorted.push(i64::from(w));
                }
            }
            sorted.sort_by_key(|&w| order(w));
            let cur = order(weekday_of_days(d));
            if let Some(&later) = sorted.iter().find(|&&w| order(w) > cur) {
                return d + order(later) - cur;
            }
            let monday = d - ((weekday_of_days(d) + 6) % 7);
            monday + 7 * n + order(sorted[0])
        }
        "month" => {
            if let Some(NthWeekday { n: nth, weekday }) = &rule.by_nth_weekday {
                let (nth, weekday) = (i64::from(*nth), i64::from(*weekday));
                if let Some(same) = nth_weekday(d, 0, nth, weekday) {
                    if same > d {
                        return same;
                    }
                }
                let mut k = n;
                while k <= n * 120 {
                    if let Some(x) = nth_weekday(d, k, nth, weekday) {
                        return x;
                    }
                    k += n;
                }
                return month_day(d, n, dom);
            }
            let day = rule.by_month_day.map_or(dom, i64::from);
            let same = month_day(d, 0, day);
            if same > d {
                same
            } else {
                month_day(d, n, day)
            }
        }
        // "year" (and anything unreadable: the server never stores one).
        _ => month_day(d, 12 * n, rule.by_month_day.map_or(dom, i64::from)),
    }
}

/// First occurrence on or after `from`, for a rule set on a task with no due date (or by quick
/// add): "every Monday" typed on a Thursday starts next Monday. `from` that isn't a date comes
/// back as it is.
pub(crate) fn first_occurrence_of(rule: &Recurrence, from: &str) -> String {
    let Some(z) = parse(from) else {
        return from.to_string();
    };
    let patterned = rule.freq == "weekday"
        || (rule.freq == "week" && rule.by_weekday.as_ref().is_some_and(|v| !v.is_empty()))
        || (rule.freq == "month" && (rule.by_month_day.is_some() || rule.by_nth_weekday.is_some()));
    if !patterned {
        return from.to_string();
    }
    let mut r = rule.clone();
    if r.freq != "weekday" {
        r.interval = Some(1);
    }
    fmt(step_after(&r, z - 1))
}

// ------------------------------------------------------------------- text

const WEEKDAY_LONG: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const WEEKDAY_SHORT: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn ord(n: i64) -> String {
    if n == -1 {
        return "last".into();
    }
    let s = if (11..=13).contains(&(n % 100)) {
        "th"
    } else {
        match n % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    format!("{n}{s}")
}

/// "Every 2 weeks on Mon, Thu", "Every month on the 2nd Tuesday", … (`describeRecurrence` in
/// shared/recurrence.ts). `due_date` is for yearly rules ("on Dec 25").
pub(crate) fn describe(rule: &Recurrence, due_date: Option<&str>) -> String {
    let mut s;
    if rule.freq == "weekday" {
        s = "Every weekday".to_string();
    } else {
        let n = interval(rule);
        s = if n == 1 {
            match rule.freq.as_str() {
                "day" => "Every day".to_string(),
                "week" => "Every week".to_string(),
                "month" => "Every month".to_string(),
                _ => "Every year".to_string(),
            }
        } else {
            format!("Every {n} {}s", rule.freq)
        };
        if rule.freq == "week" {
            if let Some(days) = rule.by_weekday.as_ref().filter(|v| !v.is_empty()) {
                let order = |w: u8| (usize::from(w) + 6) % 7;
                let mut ds: Vec<u8> = Vec::new();
                for &d in days {
                    if !ds.contains(&d) {
                        ds.push(d);
                    }
                }
                ds.sort_by_key(|&d| order(d));
                let names: Vec<&str> = ds
                    .iter()
                    .map(|&d| {
                        WEEKDAY_SHORT
                            .get(usize::from(d))
                            .copied()
                            .unwrap_or("undefined")
                    })
                    .collect();
                s += &format!(" on {}", names.join(", "));
            }
        }
        if rule.freq == "month" {
            if let Some(NthWeekday { n, weekday }) = &rule.by_nth_weekday {
                s += &format!(
                    " on the {} {}",
                    ord(i64::from(*n)),
                    WEEKDAY_LONG
                        .get(usize::from(*weekday))
                        .copied()
                        .unwrap_or("undefined")
                );
            } else if let Some(d) = rule.by_month_day.filter(|&d| d != 0) {
                if d == -1 {
                    s += " on the last day";
                } else {
                    s += &format!(" on the {}", ord(i64::from(d)));
                }
            }
        }
        if rule.freq == "year" {
            if let Some(z) = due_date.and_then(parse) {
                let (_, m, d) = civil(z);
                s += &format!(
                    " on {} {}",
                    MONTHS[(m - 1) as usize],
                    rule.by_month_day.map_or(d, i64::from)
                );
            }
        }
    }
    if rule.basis.as_deref() == Some("completion") {
        s += " after completion";
    }
    if let Some(u) = rule.until.as_deref().filter(|u| !u.is_empty()) {
        s += &format!(" until {u}");
    }
    if let Some(c) = rule.count.filter(|&c| c != 0) {
        s += &format!(", {c} times");
    }
    s
}

/// A JavaScript regular expression's source, for this engine: `\b` is ASCII word boundaries
/// (Rust's would be Unicode ones) and `\d` ASCII digits; `insensitive` is the `i` flag.
pub(crate) fn js_regex(src: &str, insensitive: bool) -> Regex {
    let src = src.replace(r"\b", r"(?-u:\b)").replace(r"\d", "[0-9]");
    let src = if insensitive {
        format!("(?i){src}")
    } else {
        src
    };
    Regex::new(&src).unwrap_or_else(|e| panic!("bad built-in pattern {src}: {e}"))
}

const DAY_WORD: &str = r"(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)";

fn dow(word: &str) -> Option<u8> {
    Some(match word {
        "su" | "sun" | "sunday" => 0,
        "mo" | "mon" | "monday" => 1,
        "tu" | "tue" | "tues" | "tuesday" => 2,
        "we" | "wed" | "wednesday" => 3,
        "th" | "thu" | "thur" | "thurs" | "thursday" => 4,
        "fr" | "fri" | "friday" => 5,
        "sa" | "sat" | "saturday" => 6,
        _ => return None,
    })
}

fn nth_word(w: &str) -> i8 {
    match w {
        "first" | "1st" => 1,
        "second" | "2nd" => 2,
        "third" | "3rd" => 3,
        "fourth" | "4th" => 4,
        "fifth" | "5th" => 5,
        _ => -1, // last
    }
}

/// The days named in a list ("mon, thu and fri"), once each, in the order written.
fn parse_days(s: &str) -> Vec<u8> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| js_regex(DAY_WORD, true));
    let mut out: Vec<u8> = Vec::new();
    for m in re.find_iter(s) {
        if let Some(d) = dow(&m.as_str().to_lowercase()) {
            if !out.contains(&d) {
                out.push(d);
            }
        }
    }
    out
}

/// `num`: the count word or digits of "every 3 days", "every other week" (1 when absent or out of range).
fn num(s: Option<&str>) -> u32 {
    let Some(s) = s.filter(|s| !s.is_empty()) else {
        return 1;
    };
    let n: u32 = match s.to_lowercase().as_str() {
        "other" | "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        d => d.parse().unwrap_or(0),
    };
    if (1..=365).contains(&n) {
        n
    } else {
        1
    }
}

fn simple(freq: &str, interval: u32) -> Recurrence {
    Recurrence {
        freq: freq.into(),
        interval: Some(interval),
        ..Default::default()
    }
}

fn adverb(w: &str) -> Recurrence {
    match w {
        "daily" => simple("day", 1),
        "weekly" => simple("week", 1),
        "fortnightly" | "biweekly" => simple("week", 2),
        "quarterly" => simple("month", 3),
        "monthly" => simple("month", 1),
        _ => simple("year", 1),
    }
}

type Build = fn(&Captures) -> Option<Recurrence>;

fn patterns() -> &'static Vec<(Regex, Build)> {
    static P: OnceLock<Vec<(Regex, Build)>> = OnceLock::new();
    P.get_or_init(|| {
        let day_list = format!(r"{DAY_WORD}(?:\s*(?:,|and|&|\+|/)?\s*{DAY_WORD})*");
        let nth = r"(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)";
        let mut v: Vec<(Regex, Build)> = Vec::new();
        // every 2 weeks on mon, thu   /   every week on monday
        v.push((
            js_regex(
                &format!(r"\b(?:every|each)\s+(?:(\d+|other|two|three|four)\s+)?weeks?\s+on\s+({day_list})\b"),
                true,
            ),
            |m| {
                Some(Recurrence {
                    by_weekday: Some(parse_days(&m[2])),
                    ..simple("week", num(m.get(1).map(|x| x.as_str())))
                })
            },
        ));
        // every month on the 15th / the last day
        v.push((
            js_regex(
                r"\b(?:every|each)\s+(?:(\d+|other|two|three|four|six)\s+)?months?\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b",
                true,
            ),
            |m| {
                let d: i32 = m[2].parse().ok()?;
                (1..=31).contains(&d).then(|| Recurrence {
                    by_month_day: Some(d),
                    ..simple("month", num(m.get(1).map(|x| x.as_str())))
                })
            },
        ));
        v.push((
            js_regex(
                r"\b(?:every|each)\s+(?:(\d+|other|two|three|four|six)\s+)?months?\s+on\s+the\s+last\s+day\b",
                true,
            ),
            |m| {
                Some(Recurrence {
                    by_month_day: Some(-1),
                    ..simple("month", num(m.get(1).map(|x| x.as_str())))
                })
            },
        ));
        // every month on the 2nd tuesday  /  every 2nd tuesday  /  every last friday (of the month)
        v.push((
            js_regex(
                &format!(r"\b(?:every|each)\s+(?:(\d+|other|two|three|four|six)\s+)?months?\s+on\s+the\s+{nth}\s+({DAY_WORD})\b"),
                true,
            ),
            |m| {
                Some(Recurrence {
                    by_nth_weekday: Some(NthWeekday {
                        n: nth_word(&m[2].to_lowercase()),
                        weekday: dow(&m[3].to_lowercase())?,
                    }),
                    ..simple("month", num(m.get(1).map(|x| x.as_str())))
                })
            },
        ));
        v.push((
            js_regex(
                &format!(r"\b(?:every|each|the)\s+{nth}\s+({DAY_WORD})(?:\s+of\s+(?:the|each|every)\s+month)?\b"),
                true,
            ),
            |m| {
                Some(Recurrence {
                    by_nth_weekday: Some(NthWeekday {
                        n: nth_word(&m[1].to_lowercase()),
                        weekday: dow(&m[2].to_lowercase())?,
                    }),
                    ..simple("month", 1)
                })
            },
        ));
        // every 15th (of the month)
        v.push((
            js_regex(
                r"\b(?:every|each)\s+(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|each|every)\s+month)?\b",
                true,
            ),
            |m| {
                let d: i32 = m[1].parse().ok()?;
                (1..=31).contains(&d).then(|| Recurrence {
                    by_month_day: Some(d),
                    ..simple("month", 1)
                })
            },
        ));
        // every weekday / workday
        v.push((
            js_regex(
                r"\b(?:every|each)\s+(?:weekday|workday|work\s+day|business\s+day)s?\b|\bweekdays\b",
                true,
            ),
            |_| {
                Some(Recurrence {
                    freq: "weekday".into(),
                    ..Default::default()
                })
            },
        ));
        // every monday, every mon and thu
        v.push((
            js_regex(&format!(r"\b(?:every|each)\s+({day_list})\b"), true),
            |m| {
                Some(Recurrence {
                    by_weekday: Some(parse_days(&m[1])),
                    ..simple("week", 1)
                })
            },
        ));
        // every 3 days, every other week, every month
        v.push((
            js_regex(
                r"\b(?:every|each)\s+(?:(\d+|other|two|three|four|five|six)\s+)?(day|week|month|year)s?\b",
                true,
            ),
            |m| {
                Some(simple(
                    &m[2].to_lowercase(),
                    num(m.get(1).map(|x| x.as_str())),
                ))
            },
        ));
        v.push((
            js_regex(
                r"\b(daily|weekly|fortnightly|biweekly|monthly|quarterly|yearly|annually)\b",
                true,
            ),
            |m| Some(adverb(&m[1].to_lowercase())),
        ));
        v
    })
}

/// A rule found in text, and where (byte offsets of the phrase, suffixes included).
pub(crate) struct ParsedRecurrence {
    pub rule: Recurrence,
    pub start: usize,
    pub end: usize,
}

/// Finds a recurrence phrase in free text (`parseRecurrence`): daily, every 3 days, every
/// other week, every monday, every 2 weeks on mon,thu, every month on the 15th, every last
/// friday, … with the suffixes "until 2026-12-31", "for 10 times" / "x10" and "after
/// completion".
pub(crate) fn parse_recurrence(text: &str) -> Option<ParsedRecurrence> {
    static UNTIL: OnceLock<Regex> = OnceLock::new();
    static COUNT: OnceLock<Regex> = OnceLock::new();
    static BASIS: OnceLock<Regex> = OnceLock::new();
    let until = UNTIL.get_or_init(|| js_regex(r"^\s+until\s+(\d{4}-\d{2}-\d{2})\b", true));
    let count =
        COUNT.get_or_init(|| js_regex(r"^\s+(?:for\s+(\d{1,4})\s+times|x\s?(\d{1,4}))\b", true));
    let basis = BASIS.get_or_init(|| {
        js_regex(
            r"^\s+(?:after|from)\s+(?:completion|completed|done)\b",
            true,
        )
    });
    for (re, build) in patterns() {
        let Some(m) = re.captures(text) else {
            continue;
        };
        let Some(mut rule) = build(&m) else {
            continue;
        };
        let whole = m.get(0)?;
        let mut end = whole.end();
        loop {
            let rest = &text[end..];
            let len;
            if let Some(s) = until.captures(rest).filter(|s| is_iso_date(&s[1])) {
                rule.until = Some(s[1].to_string());
                len = s[0].len();
            } else if let Some(s) = count.captures(rest) {
                rule.count = s
                    .get(1)
                    .or_else(|| s.get(2))
                    .and_then(|x| x.as_str().parse().ok());
                len = s[0].len();
            } else if let Some(s) = basis.captures(rest) {
                rule.basis = Some("completion".into());
                len = s[0].len();
            } else {
                break;
            }
            end += len;
        }
        return Some(ParsedRecurrence {
            rule,
            start: whole.start(),
            end,
        });
    }
    None
}
