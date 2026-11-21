//! Clean a page that came from outside (workspace import) with the editor's rules
//! (server/sanitizeDoc.ts):
//!   - images with an unsafe src are removed;
//!   - file cards with an unsafe url are removed;
//!   - link marks with an unsafe href are removed (the text stays);
//!   - text colour / highlight marks keep only palette names;
//!   - `ink` entries that aren't stroke blobs are removed.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::types::text::YChange;
use yrs::types::Attrs;
use yrs::{Any, Doc, Map, Out, ReadTxn, Text, Transact, TransactionMut, Xml, XmlFragment, XmlOut};

use crate::page::{box_field, box_geoms, is_stroke_value, reading_order, DEFAULT_FIELD, INK_KEY};
use crate::urls::{is_color_name, safe_file_url, safe_image_url, safe_link_url};

/// y-prosemirror stores a mark under its name, or `name--<hash>` for marks that can overlap.
fn is_mark_key(k: &str, name: &str) -> bool {
    k == name || k.strip_prefix(name).is_some_and(|r| r.starts_with("--"))
}

fn str_of(v: Option<&Any>) -> Option<&str> {
    match v {
        Some(Any::String(s)) => Some(s),
        _ => None,
    }
}

fn clean_text(txn: &mut TransactionMut, t: &yrs::XmlTextRef) -> u32 {
    let mut removed = 0;
    let mut pos = 0u32;
    for d in t.diff(txn, YChange::identity) {
        let len = match &d.insert {
            Out::Any(Any::String(s)) => crate::js::utf16_len(s),
            _ => 1,
        };
        let mut change: Attrs = HashMap::new();
        for (k, v) in d.attributes.iter().flat_map(|a| a.iter()) {
            let color = crate::js::field(Some(v), "color");
            if is_mark_key(k, "textStyle") && !is_color_name(str_of(color)) {
                change.insert(k.clone(), Any::Null);
            }
            if is_mark_key(k, "highlight")
                && !matches!(color, None | Some(Any::Null) | Some(Any::Undefined))
                && !is_color_name(str_of(color))
            {
                if let Any::Map(m) = v {
                    let mut m = (**m).clone();
                    m.insert("color".into(), Any::Null);
                    change.insert(k.clone(), Any::Map(Arc::new(m)));
                }
            }
            if !is_mark_key(k, "link") {
                continue;
            }
            if safe_link_url(str_of(crate::js::field(Some(v), "href"))).is_empty() {
                change.insert(k.clone(), Any::Null);
                removed += 1;
            }
        }
        if !change.is_empty() {
            t.format(txn, pos, len, change);
        }
        pos += len;
    }
    removed
}

fn attr_str<T: ReadTxn>(txn: &T, el: &yrs::XmlElementRef, k: &str) -> Option<String> {
    match el.get_attribute(txn, k) {
        Some(Out::Any(Any::String(s))) => Some(s.to_string()),
        _ => None,
    }
}

fn clean_children<P: XmlFragment>(txn: &mut TransactionMut, parent: &P) -> u32 {
    let mut removed = 0;
    let kids: Vec<XmlOut> = parent.children(txn).collect();
    // Back to front, so deleting doesn't shift the indexes still to visit.
    for (i, c) in kids.iter().enumerate().rev() {
        match c {
            XmlOut::Text(t) => removed += clean_text(txn, t),
            XmlOut::Element(el) => {
                let unsafe_url = match &*el.tag().clone() {
                    "image" => safe_image_url(attr_str(txn, el, "src").as_deref()).is_empty(),
                    "fileAttachment" => {
                        safe_file_url(attr_str(txn, el, "url").as_deref()).is_empty()
                    }
                    _ => false,
                };
                if unsafe_url {
                    parent.remove_range(txn, i as u32, 1);
                    removed += 1;
                    continue;
                }
                removed += clean_children(txn, el);
            }
            XmlOut::Fragment(_) => {}
        }
    }
    removed
}

/// Sanitise a whole page in place, in one transaction; returns how many links, nodes and ink entries were removed.
pub fn sanitize_doc(doc: &Doc) -> u32 {
    let mut txn = doc.transact_mut();
    let mut names = vec![DEFAULT_FIELD.to_string()];
    names.extend(
        reading_order(box_geoms(&txn))
            .iter()
            .map(|b| box_field(&b.id)),
    );
    let mut removed = 0;
    for name in names {
        if let Some(frag) = txn.get_xml_fragment(name.as_str()) {
            removed += clean_children(&mut txn, &frag);
        }
    }
    if let Some(ink) = txn.get_map(INK_KEY) {
        let bad: Vec<String> = ink
            .iter(&txn)
            .filter(|(_, v)| !is_stroke_value(v))
            .map(|(k, _)| k.to_string())
            .collect();
        for k in &bad {
            ink.remove(&mut txn, k);
        }
        removed += bad.len() as u32;
    }
    removed
}
