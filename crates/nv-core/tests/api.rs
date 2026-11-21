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

fn find<'a>(nodes: &'a [ContentNode], kind: &NodeKind, out: &mut Vec<&'a ContentNode>) {
    for n in nodes {
        if &n.kind == kind {
            out.push(n);
        }
        find(&n.children, kind, out);
    }
}

fn all(content: &[BoxContent], kind: NodeKind) -> Vec<&ContentNode> {
    let mut out = Vec::new();
    for b in content {
        find(&b.nodes, &kind, &mut out);
    }
    out
}

#[test]
fn content_has_typed_blocks_and_marks() {
    let content = page_content(page("document-page")).unwrap();
    assert_eq!(content[0].box_id, None);
    let h = all(&content, NodeKind::Heading);
    assert_eq!(h.len(), 3);
    assert_eq!(
        h[0].attrs[0],
        Attr {
            name: "level".into(),
            value: AttrValue::Number { value: 1.0 }
        }
    );
    let runs: Vec<&TextRun> = all(&content, NodeKind::Text)
        .into_iter()
        .flat_map(|t| &t.runs)
        .collect();
    let marks_of = |text: &str| {
        runs.iter()
            .find(|r| r.text == text)
            .unwrap_or_else(|| panic!("no run {text:?}"))
            .marks
            .clone()
    };
    assert_eq!(marks_of("bold"), [Mark::Bold]);
    assert_eq!(
        marks_of("link"),
        [Mark::Link {
            href: "https://example.com/a?b=1".into()
        }]
    );
    assert_eq!(
        marks_of("red text"),
        [Mark::TextColor {
            color: "red".into()
        }]
    );
    assert_eq!(
        marks_of("default highlight"),
        [Mark::Highlight { color: None }]
    );
    let both = marks_of(" both");
    assert_eq!(both.len(), 2);
    assert!(both.contains(&Mark::Comment {
        thread_id: "thread-2".into()
    }));
    assert_eq!(all(&content, NodeKind::CodeBlock).len(), 2);
    assert_eq!(all(&content, NodeKind::HardBreak).len(), 1);
}

#[test]
fn content_numbers_lists_and_keeps_unknown_blocks() {
    let lists = page_content(page("lists")).unwrap();
    assert_eq!(lists[1].box_id.as_deref(), Some("b1"));
    let ol = all(&lists, NodeKind::OrderedList);
    let markers: Vec<Vec<String>> = ol.iter().map(|o| o.markers.clone()).collect();
    assert_eq!(markers[0], ["1.", "2.", "3."]);
    assert_eq!(markers[1], ["a.", "b."]);
    assert_eq!(markers[2], ["4.", "5."]);
    assert_eq!(markers[3], ["7)", "8)"]);
    assert!(all(&lists, NodeKind::TaskItem)
        .iter()
        .any(|t| t.attrs.contains(&Attr {
            name: "checked".into(),
            value: AttrValue::Bool { value: true }
        })));

    let blocks = read_page(page("blocks")).unwrap().content;
    for k in [
        NodeKind::Callout,
        NodeKind::Details,
        NodeKind::Table,
        NodeKind::TableHeader,
        NodeKind::Image,
        NodeKind::FileAttachment,
        NodeKind::Mention,
        NodeKind::PageLink,
    ] {
        assert!(!all(&blocks, k.clone()).is_empty(), "{k:?}");
    }
    let tasks = page_content(page("tasks")).unwrap();
    assert_eq!(all(&tasks, NodeKind::TaskRef).len(), 6);

    let future = page_content(page("newer-format")).unwrap();
    let unknown = all(
        &future,
        NodeKind::Unknown {
            name: "futureBlock".into(),
        },
    );
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].children[0].kind, NodeKind::Paragraph);
}
