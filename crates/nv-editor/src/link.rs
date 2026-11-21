//! The link editor (EDITOR.md 4; today's `src/editor/LinkEditor.tsx`): Mod+K, the Link slash
//! item and the ribbon's link button open it on the selection, widened to the whole link when
//! the caret is in one; it has two fields, Text and Address, and Enter applies them.

use crate::editor::Editor;
use crate::node::{add_mark, remove_mark, u16_len, Mark, Node};
use crate::schema::Attrs;
use crate::selection::Selection;
use serde_json::json;

/// What people type in Address, normalised (`normaliseUrl`): `example.com` is
/// `https://example.com`, an email address is a `mailto:` link, a script URL is refused (None).
pub fn normalise_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    if ["http:", "https:", "mailto:", "tel:", "notivelo:"]
        .iter()
        .any(|p| lower.starts_with(p))
        || url.starts_with('/')
        || url.starts_with('#')
    {
        return Some(url.to_string());
    }
    if is_email(url) {
        return Some(format!("mailto:{url}"));
    }
    if ["javascript:", "data:", "vbscript:"]
        .iter()
        .any(|p| lower.starts_with(p))
    {
        return None;
    }
    Some(format!("https://{url}"))
}

/// `^[^\s@]+@[^\s@]+\.[^\s@]+$`
fn is_email(s: &str) -> bool {
    if s.contains(char::is_whitespace) {
        return false;
    }
    let Some((user, host)) = s.split_once('@') else {
        return false;
    };
    if user.is_empty() || host.contains('@') {
        return false;
    }
    match host.rsplit_once('.') {
        Some((a, b)) => !a.is_empty() && !b.is_empty(),
        None => false,
    }
}

impl Editor {
    /// The range the link editor works on: the selection, or the whole link around the caret.
    pub fn link_range(&self) -> (usize, usize) {
        let (from, to) = self.range();
        if from != to {
            return (from, to);
        }
        let Some(link) = self.marks_at(from).into_iter().find(|m| m.kind == "link") else {
            return (from, to);
        };
        let r = self.resolve(from);
        let parent = r.parent(&self.doc);
        let start = r.start(r.depth());
        // The run of inline children carrying this link that touches the caret.
        let (mut a, mut b) = (from, to);
        let mut p = start;
        let mut run: Option<usize> = None;
        let mut found = false;
        for c in &parent.content {
            let end = p + c.node_size();
            if c.marks.contains(&link) {
                let s = *run.get_or_insert(p);
                if found || (s <= from && from <= end) {
                    (a, b, found) = (s, end, true);
                }
            } else if found {
                break;
            } else {
                run = None;
            }
            p = end;
        }
        (a, b)
    }

    /// Apply the link editor: `text` is what the Text field holds (None: as it opened, the
    /// linked text), `address` the Address field. An empty address unlinks; empty text uses the
    /// address as the text. Changed text takes the marks at the range's start.
    pub fn edit_link(&mut self, text: Option<&str>, address: &str) -> bool {
        let (from, to) = self.link_range();
        let original = if from < to {
            self.text_between(from, to)
        } else {
            String::new()
        };
        let href = normalise_url(address);
        let mut label = text.map_or(original.clone(), str::to_string);
        if label.is_empty() {
            label = if href.is_some() {
                address.trim().to_string()
            } else {
                original.clone()
            };
        }
        if label.is_empty() {
            return true;
        }
        let link = |h: &str| {
            let mut a = Attrs::new();
            a.insert("href".into(), json!(h));
            Mark::new("link", a)
        };
        if label == original && from < to {
            self.remove_mark_range(from, to, "link");
            if let Some(h) = &href {
                self.add_mark_range(from, to, &link(h));
            }
            self.sel = Selection::text(from, to);
            return true;
        }
        let start_marks = if from < to {
            self.marks_at(from + 1)
        } else {
            self.stored_marks
                .clone()
                .unwrap_or_else(|| self.marks_at(from))
        };
        let mut marks = remove_mark(&start_marks, "link");
        if let Some(h) = &href {
            marks = add_mark(&marks, &link(h));
        }
        self.delete_range(from, to);
        let r = self.resolve(from);
        let off = r.parent_offset;
        self.splice(&r.path, off, off, vec![Node::text(&label, marks.clone())]);
        let end = from + u16_len(&label);
        if from < to {
            self.sel = Selection::text(from, end);
        } else {
            // A new link: the caret goes after it, and what's typed next isn't linked.
            self.sel = Selection::caret(end);
            self.stored_marks = Some(remove_mark(&marks, "link"));
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::normalise_url;

    #[test]
    fn normalises_addresses() {
        assert_eq!(
            normalise_url(" example.com ").as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            normalise_url("sam@example.test").as_deref(),
            Some("mailto:sam@example.test")
        );
        assert_eq!(
            normalise_url("HTTPS://x.test").as_deref(),
            Some("HTTPS://x.test")
        );
        assert_eq!(normalise_url("#top").as_deref(), Some("#top"));
        assert_eq!(normalise_url("javascript:alert(1)"), None);
        assert_eq!(normalise_url("  "), None);
    }
}
