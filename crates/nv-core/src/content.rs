//! Box content for the native page views: each content fragment of a page (the `default`
//! fragment, then every box in reading order) as a typed tree. It is the corpus fragment tree
//! (tests/corpus/README.md) with block kinds and marks as enums: elements have a kind, their
//! attributes and children; text nodes have runs of text with marks.

use nv_model::yrs::Any;
use nv_model::{Fragment, Insert, Node};

/// What an element is (the editor's node names, src/editor/; `Unknown` keeps a newer app's name).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum NodeKind {
    /// A text node: see `runs`.
    Text,
    Paragraph,
    /// `level` attribute 1–3.
    Heading,
    Blockquote,
    /// `language` attribute.
    CodeBlock,
    HorizontalRule,
    HardBreak,
    BulletList,
    /// `start`, `type` ("1", "a", "A", "i", "I"), `paren`, `continued` attributes; `markers` holds the item markers.
    OrderedList,
    ListItem,
    /// A checklist (plain items, not tasks).
    TaskList,
    /// `checked` attribute.
    TaskItem,
    /// A task line: `taskId` attribute; children are the task's notes.
    TaskRef,
    /// `emoji` attribute.
    Callout,
    /// A toggle: a summary, then content.
    Details,
    DetailsSummary,
    DetailsContent,
    Table,
    TableRow,
    TableCell,
    TableHeader,
    /// `src`, `alt`, `title` attributes.
    Image,
    /// A file card: `url`, `name`, `size`, `mime` attributes.
    FileAttachment,
    /// Inline: `id`, `label` attributes.
    Mention,
    /// Inline: `pageId` attribute.
    PageLink,
    /// A node this core doesn't know (written by a newer app): show its children, or "update to see this".
    Unknown {
        name: String,
    },
}

impl NodeKind {
    fn of(tag: &str) -> NodeKind {
        match tag {
            "paragraph" => NodeKind::Paragraph,
            "heading" => NodeKind::Heading,
            "blockquote" => NodeKind::Blockquote,
            "codeBlock" => NodeKind::CodeBlock,
            "horizontalRule" => NodeKind::HorizontalRule,
            "hardBreak" => NodeKind::HardBreak,
            "bulletList" => NodeKind::BulletList,
            "orderedList" => NodeKind::OrderedList,
            "listItem" => NodeKind::ListItem,
            "taskList" => NodeKind::TaskList,
            "taskItem" => NodeKind::TaskItem,
            "taskRef" => NodeKind::TaskRef,
            "callout" => NodeKind::Callout,
            "details" => NodeKind::Details,
            "detailsSummary" => NodeKind::DetailsSummary,
            "detailsContent" => NodeKind::DetailsContent,
            "table" => NodeKind::Table,
            "tableRow" => NodeKind::TableRow,
            "tableCell" => NodeKind::TableCell,
            "tableHeader" => NodeKind::TableHeader,
            "image" => NodeKind::Image,
            "fileAttachment" => NodeKind::FileAttachment,
            "mention" => NodeKind::Mention,
            "pageLink" => NodeKind::PageLink,
            other => NodeKind::Unknown {
                name: other.to_string(),
            },
        }
    }
}

/// An attribute value as stored (JSON-like).
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum AttrValue {
    Null,
    Bool {
        value: bool,
    },
    Number {
        value: f64,
    },
    Text {
        value: String,
    },
    /// Anything else (objects, arrays, bytes) as JSON text.
    Json {
        value: String,
    },
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct Attr {
    pub name: String,
    pub value: AttrValue,
}

/// An inline mark on a run of text.
#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum Mark {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Link {
        href: String,
    },
    /// A palette colour name (shared/colors.ts).
    TextColor {
        color: String,
    },
    /// A palette colour name, or none for the default (yellow).
    Highlight {
        color: Option<String>,
    },
    /// A comment thread anchored here (several may overlap).
    Comment {
        thread_id: String,
    },
    /// A mark this core doesn't know.
    Unknown {
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TextRun {
    pub text: String,
    pub marks: Vec<Mark>,
}

/// One node of a box's content.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ContentNode {
    pub kind: NodeKind,
    /// Every attribute, sorted by name (empty for text).
    pub attrs: Vec<Attr>,
    /// The text of a `Text` node (empty otherwise).
    pub runs: Vec<TextRun>,
    pub children: Vec<ContentNode>,
    /// For an `OrderedList`: each item's marker as exports number it ("1.", "b)", "iv."). Empty otherwise.
    pub markers: Vec<String>,
}

/// The content of one box (or of `default`, the old document column, when `box_id` is none).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct BoxContent {
    pub box_id: Option<String>,
    pub nodes: Vec<ContentNode>,
}

fn json(v: &Any) -> String {
    match v {
        Any::Null | Any::Undefined => "null".into(),
        Any::Bool(b) => b.to_string(),
        Any::Number(n) => nv_model::js::number_string(nv_model::js::number(n)),
        Any::String(s) => format!("{:?}", &**s),
        Any::Array(a) => format!("[{}]", a.iter().map(json).collect::<Vec<_>>().join(",")),
        Any::Map(m) => {
            let mut kv: Vec<_> = m
                .iter()
                .map(|(k, v)| format!("{k:?}:{}", json(v)))
                .collect();
            kv.sort();
            format!("{{{}}}", kv.join(","))
        }
        Any::Buffer(b) => format!(
            "[{}]",
            b.iter()
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

fn value(v: &Any) -> AttrValue {
    match v {
        Any::Null | Any::Undefined => AttrValue::Null,
        Any::Bool(b) => AttrValue::Bool { value: *b },
        Any::Number(n) => AttrValue::Number {
            value: nv_model::js::number(n),
        },
        Any::String(s) => AttrValue::Text {
            value: s.to_string(),
        },
        other => AttrValue::Json { value: json(other) },
    }
}

fn str_field(v: &Any, k: &str) -> Option<String> {
    match nv_model::js::field(Some(v), k) {
        Some(Any::String(s)) => Some(s.to_string()),
        _ => None,
    }
}

fn mark(name: &str, v: &Any) -> Option<Mark> {
    if matches!(v, Any::Null | Any::Undefined) {
        return None;
    }
    // y-prosemirror stores a mark that may overlap as `name--<hash>`.
    let base = name.split_once("--").map_or(name, |(b, _)| b);
    Some(match base {
        "bold" => Mark::Bold,
        "italic" => Mark::Italic,
        "underline" => Mark::Underline,
        "strike" => Mark::Strike,
        "code" => Mark::Code,
        "link" => Mark::Link {
            href: str_field(v, "href").unwrap_or_default(),
        },
        "textStyle" => Mark::TextColor {
            color: str_field(v, "color")?,
        },
        "highlight" => Mark::Highlight {
            color: str_field(v, "color"),
        },
        "comment" => Mark::Comment {
            thread_id: str_field(v, "threadId")?,
        },
        other => Mark::Unknown {
            name: other.to_string(),
        },
    })
}

fn node(siblings: &[Node], i: usize) -> Option<ContentNode> {
    match &siblings[i] {
        Node::Text(runs) => Some(ContentNode {
            kind: NodeKind::Text,
            attrs: Vec::new(),
            runs: runs
                .iter()
                .filter_map(|r| match &r.insert {
                    Insert::Text(t) => Some(TextRun {
                        text: t.clone(),
                        marks: r.attrs.iter().filter_map(|(k, v)| mark(k, v)).collect(),
                    }),
                    Insert::Embed(_) => None,
                })
                .collect(),
            children: Vec::new(),
            markers: Vec::new(),
        }),
        Node::Element(el) => {
            let markers = if el.tag == "orderedList" {
                let start = nv_model::lists::xml_list_start(siblings, i);
                (0..el.children.len())
                    .map(|k| {
                        format!(
                            "{}{}",
                            nv_model::lists::list_marker(el.attr("type"), start + k as f64),
                            nv_model::lists::list_suffix(el.attr("paren"))
                        )
                    })
                    .collect()
            } else {
                Vec::new()
            };
            Some(ContentNode {
                kind: NodeKind::of(&el.tag),
                attrs: el
                    .attrs
                    .iter()
                    .map(|(k, v)| Attr {
                        name: k.clone(),
                        value: value(v),
                    })
                    .collect(),
                runs: Vec::new(),
                children: nodes(&el.children),
                markers,
            })
        }
        Node::Other => None,
    }
}

fn nodes(list: &[Node]) -> Vec<ContentNode> {
    (0..list.len()).filter_map(|i| node(list, i)).collect()
}

pub(crate) fn box_contents(fragments: &[Fragment]) -> Vec<BoxContent> {
    fragments
        .iter()
        .map(|f| BoxContent {
            box_id: f.box_id.clone(),
            nodes: nodes(&f.nodes),
        })
        .collect()
}
