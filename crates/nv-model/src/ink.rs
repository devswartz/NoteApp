//! Writing a page's `ink` map the way the web does (`src/ink/strokes.ts`): the `ink` root map
//! holds stroke id -> an immutable blob (`Any::Buffer`), and every gesture is **one transaction**
//! with no origin: a local edit, which a live page sends. Strokes are never changed in place:
//! an erase or a move deletes the strokes and adds new ones with new ids (`commitErase`).
//!
//! This module knows nothing about the blob's inside (that is `nv-ink`, used by `nv-core`): it
//! only moves opaque bytes in and out of the map, so a stroke from a newer app (a blob this build
//! can't decode) is carried along untouched unless it is explicitly deleted.

use yrs::{Any, Doc, Map, Origin, Out, ReadTxn, Transact, WriteTxn};

use crate::page::{is_stroke_value, page_ink, INK_KEY};

/// The page's strokes as `(id, blob)`, sorted by id (values that aren't stroke blobs are skipped,
/// like `pageInk`).
pub fn ink_blobs(doc: &Doc) -> Vec<(String, Vec<u8>)> {
    page_ink(&doc.transact())
        .into_iter()
        .map(|s| (s.id, s.data))
        .collect()
}

/// One stroke's blob, if the page has it.
pub fn ink_blob(doc: &Doc, id: &str) -> Option<Vec<u8>> {
    let txn = doc.transact();
    match txn.get_map(INK_KEY)?.get(&txn, id)? {
        v @ Out::Any(Any::Buffer(_)) if is_stroke_value(&v) => match v {
            Out::Any(Any::Buffer(b)) => Some(b.to_vec()),
            _ => None,
        },
        _ => None,
    }
}

/// `commitErase`: in one transaction, delete the `removed` strokes that are still there (ones
/// someone else deleted already are skipped) and add each of `added` under its id. Returns the
/// ids actually removed. An empty edit writes nothing.
pub fn commit_ink(doc: &Doc, removed: &[String], added: &[(String, Vec<u8>)]) -> Vec<String> {
    commit_ink_with(doc, None, removed, added)
}

/// `commit_ink` in a transaction with the given origin (`None`: no origin). Any origin other than
/// the sync's remote one is still a local edit; a yrs `UndoManager` can track it by this origin.
pub fn commit_ink_with(
    doc: &Doc,
    origin: Option<Origin>,
    removed: &[String],
    added: &[(String, Vec<u8>)],
) -> Vec<String> {
    if removed.is_empty() && added.is_empty() {
        return Vec::new();
    }
    let mut txn = match origin {
        Some(o) => doc.transact_mut_with(o),
        None => doc.transact_mut(),
    };
    let ink = txn.get_or_insert_map(INK_KEY);
    let mut gone = Vec::new();
    for id in removed {
        if ink.contains_key(&txn, id) {
            ink.remove(&mut txn, id);
            gone.push(id.clone());
        }
    }
    for (id, blob) in added {
        ink.insert(&mut txn, id.as_str(), Any::Buffer(blob.clone().into()));
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::new_doc;

    #[test]
    fn add_remove_and_skip() {
        let doc = new_doc();
        assert!(ink_blobs(&doc).is_empty());
        commit_ink(
            &doc,
            &[],
            &[("b".into(), vec![1, 2]), ("a".into(), vec![3])],
        );
        assert_eq!(
            ink_blobs(&doc),
            vec![("a".into(), vec![3]), ("b".into(), vec![1, 2])]
        );
        let gone = commit_ink(&doc, &["a".into(), "zz".into()], &[("c".into(), vec![9])]);
        assert_eq!(gone, vec!["a".to_string()]);
        assert_eq!(ink_blob(&doc, "c"), Some(vec![9]));
        assert_eq!(ink_blob(&doc, "a"), None);
        // A value that isn't a blob is never returned, and an edit leaves it alone.
        {
            let mut t = doc.transact_mut();
            let ink = t.get_or_insert_map(INK_KEY);
            ink.insert(&mut t, "junk", "text");
        }
        commit_ink(&doc, &[], &[("d".into(), vec![1])]);
        assert_eq!(ink_blob(&doc, "junk"), None);
        let t = doc.transact();
        assert!(t.get_map(INK_KEY).unwrap().contains_key(&t, "junk"));
    }
}
