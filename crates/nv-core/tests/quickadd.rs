//! Quick add and repeat-rule text against today's web code: `tests/corpus/quickadd.json`, made by
//! `scripts/corpus/quickadd.ts` (`parseQuickAdd`, `describeRecurrence`, `firstOccurrence`).

use nv_core::{
    describe_recurrence, first_occurrence, parse_quick_add, QuickAddKind, TaskRecurrence,
};
use serde_json::{json, Value};

fn corpus() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/corpus/quickadd.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus file")).unwrap()
}

fn recurrence(v: &Value) -> TaskRecurrence {
    let r: nv_api::Recurrence = serde_json::from_value(v.clone()).unwrap();
    TaskRecurrence::from(&r)
}

fn as_json(r: &nv_core::QuickAddResult) -> Value {
    let rule = r
        .recurrence
        .as_ref()
        .map(|t| serde_json::to_value(nv_api::Recurrence::from(t)).unwrap());
    json!({
        "title": r.title, "dueDate": r.due_date, "dueTime": r.due_time, "priority": r.priority,
        "recurrence": rule, "assignee": r.assignee, "tags": r.tags, "team": r.team,
        "tokens": r.tokens.iter().map(|t| json!({
            "start": t.start, "end": t.end,
            "kind": match t.kind {
                QuickAddKind::Date => "date", QuickAddKind::Time => "time", QuickAddKind::Priority => "priority",
                QuickAddKind::Recurrence => "recurrence", QuickAddKind::Assignee => "assignee",
                QuickAddKind::Tag => "tag", QuickAddKind::Team => "team",
            },
        })).collect::<Vec<_>>(),
    })
}

#[test]
fn every_line_parses_as_the_web_parses_it() {
    let c = corpus();
    let cases = c["cases"].as_array().unwrap();
    assert!(cases.len() > 400);
    let mut bad = Vec::new();
    for case in cases {
        let (today, input) = (
            case["today"].as_str().unwrap(),
            case["input"].as_str().unwrap(),
        );
        let got = as_json(&parse_quick_add(input.into(), today.into()));
        if got != case["expected"] {
            bad.push(format!(
                "today {today}, {input:?}\n  web:  {}\n  rust: {got}",
                case["expected"]
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {} differ:\n{}",
        bad.len(),
        cases.len(),
        bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn rules_describe_and_start_as_the_web_says() {
    let c = corpus();
    let mut bad = Vec::new();
    for r in c["rules"].as_array().unwrap() {
        let rule = recurrence(&r["rule"]);
        for d in r["describe"].as_array().unwrap() {
            let due = d["dueDate"].as_str().map(String::from);
            let got = describe_recurrence(rule.clone(), due.clone());
            if got != d["text"].as_str().unwrap() {
                bad.push(format!(
                    "describe {} due {due:?}: web {:?}, rust {got:?}",
                    r["rule"], d["text"]
                ));
            }
        }
        for f in r["firstOccurrence"].as_array().unwrap() {
            let from = f["from"].as_str().unwrap();
            let got = first_occurrence(rule.clone(), from.into());
            if got != f["date"].as_str().unwrap() {
                bad.push(format!(
                    "first {} from {from}: web {}, rust {got}",
                    r["rule"], f["date"]
                ));
            }
        }
    }
    assert!(
        bad.is_empty(),
        "{} differ:\n{}",
        bad.len(),
        bad.iter().take(12).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn the_documented_examples() {
    let r = parse_quick_add(
        "Call Sam tomorrow 3pm p1 @sam #waiting +elders every week".into(),
        "2026-11-05".into(),
    );
    assert_eq!(
        (
            r.title.as_str(),
            r.due_date.as_deref(),
            r.due_time.as_deref(),
            r.priority,
            r.assignee.as_deref()
        ),
        (
            "Call Sam",
            Some("2026-11-06"),
            Some("15:00"),
            Some(1),
            Some("sam")
        )
    );
    assert_eq!(
        (r.tags.clone(), r.team.clone()),
        (vec!["waiting".to_string()], Some("elders".to_string()))
    );
    // UTF-16 offsets: the emoji is two units.
    let r = parse_quick_add("😀 buy milk tomorrow".into(), "2026-11-05".into());
    assert_eq!((r.tokens[0].start, r.tokens[0].end), (12, 20));
    // A bad "today" falls back to the clock rather than failing.
    assert!(parse_quick_add("x tomorrow".into(), "nonsense".into())
        .due_date
        .is_some());
}
