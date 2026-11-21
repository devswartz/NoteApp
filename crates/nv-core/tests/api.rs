//! The Core API on corpus pages (tests/corpus/): the same answers nv-model gives, through the boundary types.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use nv_core::*;

fn page(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/corpus/cases")
            .join(name)
            .join("page.bin"),
    )
    .unwrap()
}
fn file(name: &str, f: &str) -> String {
    fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/corpus/cases")
            .join(name)
            .join(f),
    )
    .unwrap()
}

#[test]
fn reads_a_canvas() {
    let info = read_page(page("canvas-boxes")).unwrap();
    assert_eq!(info.kind, PageKind::Canvas);
    assert_eq!(
        info.boxes.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
        ["top", "a", "b", "c", "empty", "blank"]
    );
    assert_eq!(
        info.headings[0],
        PageHeading {
            box_id: "top".into(),
            index: 0,
            level: 1,
            text: "Top box".into()
        }
    );
    assert_eq!(info.task_ids, ["tb"]);
    assert_eq!(info.text, file("canvas-boxes", "page.txt"));
    assert!(!info.newer_format);
}

#[test]
fn settings_ink_and_format() {
    let info = read_page(page("settings-and-ink")).unwrap();
    assert_eq!(
        info.settings,
        PageSettings {
            color: "blue".into(),
            rules: "grid".into()
        }
    );
    assert!(info.has_ink);
    assert_eq!(info.format_version, 2);
    assert!(read_page(page("newer-format")).unwrap().newer_format);
    assert_eq!(
        read_page(page("document-page")).unwrap().kind,
        PageKind::Document
    );
    assert_eq!(page_format_version(), 2);
}

#[test]
fn markdown_matches_the_corpus() {
    let tasks = HashMap::from([
        (
            "t1".to_string(),
            TaskLineInput::Shown {
                title: "Write the plan".into(),
                done: false,
                due: Some("2026-11-30".into()),
            },
        ),
        (
            "t2".to_string(),
            TaskLineInput::Shown {
                title: "Ship it".into(),
                done: true,
                due: None,
            },
        ),
        (
            "t3".to_string(),
            TaskLineInput::Shown {
                title: "Subtask".into(),
                done: false,
                due: None,
            },
        ),
        ("hidden".to_string(), TaskLineInput::Hidden),
    ]);
    assert_eq!(
        page_markdown(page("tasks"), "Tasks".into(), tasks).unwrap(),
        file("tasks", "page.md")
    );
}

#[test]
fn sanitize_round_trips() {
    let out = sanitize_page(page("sanitize")).unwrap();
    assert_eq!(out.removed, 10);
    // The cleaned document is a page again, and already clean.
    assert_eq!(sanitize_page(out.update).unwrap().removed, 0);
}

#[test]
fn errors_and_markers() {
    assert!(matches!(
        read_page(vec![1, 2, 3]),
        Err(CoreError::InvalidPage { .. })
    ));
    assert_eq!(list_marker(Some("I".into()), 1994), "MCMXCIV");
    assert_eq!(list_marker(None, 3), "3");
    assert!(!core_version().is_empty());
}
