//! Restoring an earlier version of a page into its live document, the way the web does
//! (`replacePageContent` in `shared/pageDoc.ts`, called from `src/editor/VersionHistory.tsx`).
//!
//! The server has no restore route: a restore is an ordinary edit of the live document. Inside
//! **one transaction** the target's content (the `default` fragment, every box's fragment and
//! entry) is deleted and a **copy** of the version's content is inserted, box ids and geometry
//! kept, then the page settings and the handwriting are brought back. Because the copy is made
//! of new items, the restore is a plain Yjs update that every other copy of the page applies
//! like any edit and converges on; and because the old content is deleted (not "not merged"),
//! no copy of the page, however stale, can bring it back: a deleted item stays deleted in every
//! merge. Merging the *version's* own update into the live document would do nothing at all
//! (its items are all there already, some deleted), which is why a restore cannot be done that way.

use yrs::types::Attrs;
use yrs::{
    Any, Doc, Map, MapPrelim, Out, ReadTxn, Text, Transact, TransactionMut, WriteTxn, Xml,
    XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

use crate::page::{
    box_field, box_geoms, page_ink, page_settings, BoxGeom, BOXES_KEY, DEFAULT_FIELD, INK_KEY,
    PAGE_SETTINGS_KEY,
};
use crate::tree::{read_fragment, Insert, Node};

/// The width of the box an old single-column page's content becomes (`CONVERTED_BOX_W`).
pub const CONVERTED_BOX_W: f64 = 686.0;

fn u16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn clear<F: XmlFragment>(txn: &mut TransactionMut, f: &F) {
    let len = f.len(txn);
    if len > 0 {
        f.remove_range(txn, 0, len);
    }
}

fn attrs(a: &[(String, Any)]) -> Attrs {
    a.iter()
        .map(|(k, v)| (k.as_str().into(), v.clone()))
        .collect()
}

/// Write `nodes` at the end of `parent`: elements with their attributes, text with its marks.
fn insert_nodes<P: XmlFragment>(txn: &mut TransactionMut, parent: &P, nodes: &[Node]) {
    for n in nodes {
        match n {
            Node::Element(e) => {
                let el = parent.push_back(txn, XmlElementPrelim::empty(e.tag.as_str()));
                for (k, v) in &e.attrs {
                    el.insert_attribute(txn, k.as_str(), v.clone());
                }
                insert_nodes(txn, &el, &e.children);
            }
            Node::Text(runs) => {
                let t = parent.push_back(txn, XmlTextPrelim::new(""));
                let mut at = 0;
                for r in runs {
                    match &r.insert {
                        Insert::Text(s) => {
                            t.insert_with_attributes(txn, at, s, attrs(&r.attrs));
                            at += u16_len(s);
                        }
                        Insert::Embed(v) => {
                            t.insert_embed_with_attributes(txn, at, v.clone(), attrs(&r.attrs));
                            at += 1;
                        }
                    }
                }
            }
            Node::Other => {}
        }
    }
}

/// `fragmentIsEmpty`: no nodes, or only paragraphs holding no text.
fn is_empty(nodes: &[Node]) -> bool {
    crate::boxes::fragment_is_empty(nodes)
}

fn geometry(g: &BoxGeom) -> MapPrelim {
    let mut fields = vec![
        ("x", Any::from(g.x)),
        ("y", Any::from(g.y)),
        ("w", Any::from(g.w)),
        ("z", Any::from(g.z)),
    ];
    if g.wide {
        fields.push(("wide", Any::Bool(true)));
    }
    MapPrelim::from_iter(fields.into_iter().map(|(k, v)| (k.to_string(), v)))
}

/// Replace all of `target`'s page content with a copy of `source`'s, in one transaction (one
/// update for a live page to send), laid out as a canvas. Returns the id of the box an old
/// single-column version's content became, if any (`new_box_id` makes it).
pub fn replace_page_content(
    target: &Doc,
    source: &Doc,
    new_box_id: &mut dyn FnMut() -> String,
) -> Option<String> {
    // Read the source first, whole; the target is written under one transaction after.
    let (default, boxes, settings, ink, settings_set) = {
        let txn = source.transact();
        let boxes: Vec<(BoxGeom, Vec<Node>)> = box_geoms(&txn)
            .into_iter()
            .map(|g| {
                let nodes = read_fragment(&txn, &box_field(&g.id));
                (g, nodes)
            })
            .collect();
        let settings_set = txn
            .get_map(PAGE_SETTINGS_KEY)
            .is_some_and(|m| m.len(&txn) > 0);
        (
            read_fragment(&txn, DEFAULT_FIELD),
            boxes,
            page_settings(&txn),
            page_ink(&txn),
            settings_set,
        )
    };

    let mut txn = target.transact_mut();
    let def = txn.get_or_insert_xml_fragment(DEFAULT_FIELD);
    clear(&mut txn, &def);
    let box_map = txn.get_or_insert_map(BOXES_KEY);
    let current: Vec<String> = box_map.keys(&txn).map(String::from).collect();
    for id in current {
        let f = txn.get_or_insert_xml_fragment(box_field(&id));
        clear(&mut txn, &f);
        box_map.remove(&mut txn, &id);
    }

    let mut top_z = 0.0_f64;
    for (g, nodes) in &boxes {
        let f = txn.get_or_insert_xml_fragment(box_field(&g.id));
        clear(&mut txn, &f);
        insert_nodes(&mut txn, &f, nodes);
        box_map.insert(&mut txn, g.id.as_str(), geometry(g));
        top_z = top_z.max(g.z);
    }

    // A version from before pages were canvases: its single column becomes one wide box.
    let mut created = None;
    if !is_empty(&default) {
        let id = new_box_id();
        let f = txn.get_or_insert_xml_fragment(box_field(&id));
        insert_nodes(&mut txn, &f, &default);
        let g = BoxGeom {
            id: id.clone(),
            x: 0.0,
            y: 0.0,
            w: CONVERTED_BOX_W,
            z: top_z + 1.0,
            wide: true,
        };
        box_map.insert(&mut txn, id.as_str(), geometry(&g));
        created = Some(id);
    }

    // A version saved with page settings brings them back; one from before they existed keeps
    // the current ones.
    if settings_set {
        let map = txn.get_or_insert_map(PAGE_SETTINGS_KEY);
        for (k, v) in [("color", &settings.color), ("rules", &settings.rules)] {
            let same =
                matches!(map.get(&txn, k), Some(Out::Any(Any::String(s))) if &*s == v.as_str());
            if !same {
                map.insert(&mut txn, k, v.as_str());
            }
        }
    }

    // Handwriting is part of what a version restores.
    let ink_map = txn.get_or_insert_map(INK_KEY);
    let keep: std::collections::HashSet<&str> = ink.iter().map(|s| s.id.as_str()).collect();
    let have: Vec<String> = ink_map.keys(&txn).map(String::from).collect();
    for k in have {
        if !keep.contains(k.as_str()) {
            ink_map.remove(&mut txn, &k);
        }
    }
    for s in &ink {
        let same = matches!(
            ink_map.get(&txn, &s.id),
            Some(Out::Any(Any::Buffer(b))) if b.as_ref() == s.data.as_slice()
        );
        if !same {
            ink_map.insert(&mut txn, s.id.as_str(), Any::Buffer(s.data.clone().into()));
        }
    }
    created
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::boxes::create_box;
    use crate::{new_doc, Page};
    use yrs::updates::decoder::Decode;
    use yrs::{StateVector, Update};

    fn write_box(doc: &Doc, id: &str, text: &str, bold: bool) {
        let mut txn = doc.transact_mut();
        let f = txn.get_or_insert_xml_fragment(box_field(id));
        let p = f.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p.insert_attribute(&mut txn, "align", "center");
        let t = p.push_back(&mut txn, XmlTextPrelim::new(""));
        let mut a = Attrs::new();
        if bold {
            a.insert("bold".into(), Any::from(true));
        }
        t.insert_with_attributes(&mut txn, 0, text, a);
    }

    fn full(doc: &Doc) -> Vec<u8> {
        doc.transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    fn apply(doc: &Doc, update: &[u8]) {
        doc.transact_mut()
            .apply_update(Update::decode_v1(update).unwrap())
            .unwrap();
    }

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("new{n}")
        }
    }

    fn texts(doc: &Doc) -> Vec<(String, String)> {
        let page = Page::read(doc);
        page.reading_order()
            .into_iter()
            .map(|b| {
                let f = Page::fragment(doc, &box_field(&b.id));
                (
                    b.id,
                    crate::text::extract_nodes(&f.nodes).text.trim().to_string(),
                )
            })
            .collect()
    }

    fn version() -> Doc {
        let v = new_doc();
        create_box(&v, "a", 10.0, 20.0, 300.0, 1.0).unwrap();
        create_box(&v, "b", 400.0, 20.0, 200.0, 2.0).unwrap();
        write_box(&v, "a", "old A", true);
        write_box(&v, "b", "old B", false);
        v
    }

    fn current() -> Doc {
        let c = new_doc();
        create_box(&c, "a", 0.0, 0.0, 500.0, 1.0).unwrap();
        create_box(&c, "z", 5.0, 5.0, 150.0, 3.0).unwrap();
        write_box(&c, "a", "new A", false);
        write_box(&c, "z", "only now", false);
        c
    }

    #[test]
    fn the_version_replaces_boxes_text_marks_and_geometry() {
        let (target, source) = (current(), version());
        assert!(replace_page_content(&target, &source, &mut ids()).is_none());
        let (t, s) = (Page::read(&target), Page::read(&source));
        assert_eq!(t.boxes.len(), 2);
        assert_eq!(t.reading_order(), s.reading_order());
        // The fragments hold the same nodes: elements, attributes, marks.
        for g in s.reading_order() {
            let name = box_field(&g.id);
            assert_eq!(
                Page::fragment(&target, &name).nodes,
                Page::fragment(&source, &name).nodes
            );
        }
        assert_eq!(
            texts(&target),
            [("a".into(), "old A".into()), ("b".into(), "old B".into())]
        );
        // The box only the current page had is gone, content and entry.
        assert!(Page::fragment(&target, "box:z").nodes.is_empty());
    }

    #[test]
    fn a_restore_is_one_update_and_converges_on_another_copy() {
        let target = current();
        let peer = new_doc();
        apply(&peer, &full(&target));
        let count = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
        let c = count.clone();
        target
            .observe_update_v1("n", move |_, e| c.lock().unwrap().push(e.update.clone()))
            .unwrap();
        replace_page_content(&target, &version(), &mut ids());
        let updates = count.lock().unwrap().clone();
        assert_eq!(updates.len(), 1, "one transaction, one update");
        apply(&peer, &updates[0]);
        assert_eq!(texts(&peer), texts(&target));
        assert_eq!(texts(&peer).len(), 2);
    }

    #[test]
    fn no_stale_copy_brings_the_replaced_content_back() {
        let target = current();
        let stale = full(&target);
        replace_page_content(&target, &version(), &mut ids());
        let restored = texts(&target);
        // An old copy of the page (a stored copy, a queue of earlier edits) merged into the
        // restored page changes nothing: the deletes are part of the restored state.
        apply(&target, &stale);
        assert_eq!(texts(&target), restored);
        // And the other way round: the stale copy takes the restore's update.
        let old = new_doc();
        apply(&old, &stale);
        apply(&old, &full(&target));
        assert_eq!(texts(&old), restored);
        // An edit queued before the restore, made on a copy of the old page and sent after it,
        // lands in a box that is gone: the restored boxes are untouched.
        let other = new_doc();
        apply(&other, &stale);
        write_box(&other, "z", "typed offline", false);
        apply(&target, &full(&other));
        assert_eq!(texts(&target), restored);
    }

    #[test]
    fn settings_and_ink_come_back_only_when_the_version_has_them() {
        let v = version();
        {
            let mut txn = v.transact_mut();
            let s = txn.get_or_insert_map(PAGE_SETTINGS_KEY);
            s.insert(&mut txn, "color", "blue");
            s.insert(&mut txn, "rules", "grid");
            let ink = txn.get_or_insert_map(INK_KEY);
            ink.insert(&mut txn, "s1", Any::Buffer(vec![1u8, 2, 3].into()));
        }
        let target = current();
        {
            let mut txn = target.transact_mut();
            let s = txn.get_or_insert_map(PAGE_SETTINGS_KEY);
            s.insert(&mut txn, "color", "pink");
            let ink = txn.get_or_insert_map(INK_KEY);
            ink.insert(&mut txn, "gone", Any::Buffer(vec![9u8].into()));
        }
        replace_page_content(&target, &v, &mut ids());
        let page = Page::read(&target);
        assert_eq!(
            (page.settings.color.as_str(), page.settings.rules.as_str()),
            ("blue", "grid")
        );
        assert_eq!(page.ink.len(), 1);
        assert_eq!(page.ink[0].id, "s1");

        // A version without settings leaves the current settings alone.
        let bare = version();
        replace_page_content(&target, &bare, &mut ids());
        let page = Page::read(&target);
        assert_eq!(page.settings.color, "blue");
        assert!(page.ink.is_empty());
    }

    #[test]
    fn an_old_single_column_version_becomes_one_wide_box() {
        let v = new_doc();
        {
            let mut txn = v.transact_mut();
            let f = txn.get_or_insert_xml_fragment(DEFAULT_FIELD);
            let p = f.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            p.push_back(&mut txn, XmlTextPrelim::new("single column"));
        }
        let target = current();
        let made = replace_page_content(&target, &v, &mut ids()).unwrap();
        let page = Page::read(&target);
        assert_eq!(page.boxes.len(), 1);
        let b = &page.boxes[0];
        assert_eq!(
            (b.id.as_str(), b.w, b.wide),
            (made.as_str(), CONVERTED_BOX_W, true)
        );
        assert_eq!(texts(&target), [(made, "single column".into())]);
        assert!(Page::fragment(&target, DEFAULT_FIELD).nodes.is_empty());
    }

    #[test]
    fn restoring_an_empty_version_empties_the_page() {
        let target = current();
        replace_page_content(&target, &new_doc(), &mut ids());
        assert!(Page::read(&target).boxes.is_empty());
        assert!(Page::fragment(&target, "box:a").nodes.is_empty());
    }
}
