//! Tree management through the Core against a scripted transport: what each call sends, what it
//! returns, and how the stored tree follows (it is fetched again after every accepted write).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use nv_api::{Request, Response, Transport};
use nv_core::*;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<Response, String>>>>,
    seen: Arc<Mutex<Vec<Request>>>,
}

impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back(Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        }));
        self
    }
    fn fail(&self, n: usize) -> &Self {
        for _ in 0..n {
            self.replies
                .lock()
                .unwrap()
                .push_back(Err("connection refused".into()));
        }
        self
    }
    /// The requests since the last call, as "METHOD /path".
    fn take(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .drain(..)
            .map(|r| format!("{} {}", r.method, r.url))
            .collect()
    }
    /// The body of the last request.
    fn last_body(&self) -> Value {
        let r = self.seen.lock().unwrap().last().unwrap().clone();
        serde_json::from_str(&r.body.unwrap_or_else(|| "null".into())).unwrap()
    }
}

impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen.lock().unwrap().push(req.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted request: {} {}", req.method, req.url))
    }
}

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> TempDir {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDir(std::env::temp_dir().join(format!("nv-core-tree-{}-{nanos}", std::process::id())))
    }
    fn db(&self) -> String {
        self.0.join("store.db").to_string_lossy().into_owned()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const SERVER: &str = "http://localhost:4417/api";

fn session() -> Value {
    json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
            "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } })
}

fn notebook(id: &str, pos: f64) -> Value {
    json!({ "id": id, "workspaceId": "w1", "name": format!("NB {id}"), "color": "#336699",
            "visibility": "shared", "createdBy": "u1", "position": pos })
}

fn section(id: &str, parent: Option<&str>, pos: f64) -> Value {
    json!({ "id": id, "notebookId": "n1", "parentId": parent, "name": format!("Sec {id}"),
            "color": "#996633", "position": pos })
}

fn page(id: &str, section: &str, pos: f64, locked: bool) -> Value {
    json!({ "id": id, "sectionId": section, "title": format!("Page {id}"), "icon": null, "kind": "canvas",
            "position": pos, "updatedAt": "2026-11-01", "updatedBy": null, "locked": locked })
}

fn tree(pages: Vec<Value>, trashed: Vec<Value>) -> Value {
    json!({ "notebooks": [notebook("n1", 1.0)],
            "sections": [section("s1", None, 1.0), section("s2", None, 2.0)],
            "pages": pages, "trashedPages": trashed })
}

/// A core with a store, signed in, with a tree for w1 stored (and the requests so far cleared).
fn core_with(s: &Script, dir: &TempDir, pages: Vec<Value>, trashed: Vec<Value>) -> Arc<Core> {
    s.reply(200, session());
    let core = Core::with_transport(
        SERVER.trim_end_matches("/api"),
        Box::new(s.clone()),
        Some(dir.db()),
    );
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    s.reply(200, tree(pages, trashed));
    core.tree("w1".into()).unwrap();
    s.take();
    core
}

fn titles(core: &Core) -> Vec<String> {
    let mut v: Vec<_> = core
        .cached_tree("w1".into())
        .unwrap()
        .pages
        .into_iter()
        .map(|p| format!("{}:{}", p.id, p.section_id))
        .collect();
    v.sort();
    v
}

#[test]
fn a_new_page_is_stored_at_once_and_a_rename_follows() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);

    // create: POST, then the tree again.
    s.reply(200, json!({ "id": "p2", "pendingTemplate": null }));
    s.reply(
        200,
        tree(
            vec![page("p1", "s1", 1.0, false), page("p2", "s1", 2.0, false)],
            vec![],
        ),
    );
    assert_eq!(core.create_page("s1".into(), None).unwrap(), "p2");
    assert_eq!(
        s.take(),
        [
            format!("POST {SERVER}/sections/s1/pages"),
            format!("GET {SERVER}/workspaces/w1/tree")
        ]
    );
    assert_eq!(
        titles(&core),
        ["p1:s1", "p2:s1"],
        "cachedTree has it already"
    );

    // rename: PATCH, then the tree again with the new title.
    s.reply(200, json!({ "ok": true }));
    let mut renamed = page("p2", "s1", 2.0, false);
    renamed["title"] = json!("Plan");
    s.reply(
        200,
        tree(vec![page("p1", "s1", 1.0, false), renamed], vec![]),
    );
    core.rename_page("p2".into(), "Plan".into()).unwrap();
    assert_eq!(s.last_body(), Value::Null, "the tree fetch has no body");
    let t = core.cached_tree("w1".into()).unwrap();
    assert_eq!(t.pages.iter().find(|p| p.id == "p2").unwrap().title, "Plan");
}

#[test]
fn bodies_and_answers_of_every_call() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    let after = |s: &Script| {
        s.reply(200, tree(vec![page("p1", "s1", 1.0, false)], vec![]));
    };
    let sent = |s: &Script| -> (String, Value) {
        let all = s.seen.lock().unwrap().clone();
        let w = &all[all.len() - 2]; // the write; the last request is the tree fetch
        (
            format!("{} {}", w.method, w.url.trim_start_matches(SERVER)),
            serde_json::from_str(w.body.as_deref().unwrap_or("null")).unwrap(),
        )
    };

    s.reply(200, json!({ "id": "n2", "sectionId": "s9" }));
    after(&s);
    let nb = core
        .create_notebook(
            "w1".into(),
            "Home".into(),
            Some("#112233".into()),
            Some("private".into()),
        )
        .unwrap();
    assert_eq!((nb.id.as_str(), nb.section_id.as_str()), ("n2", "s9"));
    assert_eq!(
        sent(&s),
        (
            "POST /workspaces/w1/notebooks".into(),
            json!({ "name": "Home", "color": "#112233", "visibility": "private" })
        )
    );

    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.rename_notebook("n1".into(), "Work".into()).unwrap();
    assert_eq!(
        sent(&s),
        ("PATCH /notebooks/n1".into(), json!({ "name": "Work" }))
    );
    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.set_notebook_color("n1".into(), "#abcdef".into())
        .unwrap();
    assert_eq!(sent(&s).1, json!({ "color": "#abcdef" }));
    s.reply(200, json!({ "ok": true, "removedPageShares": 1 }));
    after(&s);
    assert_eq!(
        core.set_notebook_visibility("n1".into(), "private".into())
            .unwrap(),
        1
    );
    assert_eq!(sent(&s).1, json!({ "visibility": "private" }));
    s.reply(200, json!({ "ok": true, "position": 0.0 }));
    after(&s);
    assert_eq!(core.move_notebook("n1".into(), Some(0)).unwrap(), 0.0);
    assert_eq!(
        sent(&s),
        ("POST /notebooks/n1/move".into(), json!({ "index": 0 }))
    );
    s.reply(200, json!({ "ok": true, "trashId": "n1", "tasks": 2 }));
    after(&s);
    let t = core.delete_notebook("n1".into()).unwrap();
    assert_eq!((t.trash_id.as_str(), t.tasks), ("n1", 2));
    assert_eq!(sent(&s).0, "DELETE /notebooks/n1");

    s.reply(200, json!({ "id": "s3" }));
    after(&s);
    assert_eq!(
        core.create_section("n1".into(), "Sub".into(), Some("s1".into()), None)
            .unwrap(),
        "s3"
    );
    assert_eq!(
        sent(&s),
        (
            "POST /notebooks/n1/sections".into(),
            json!({ "name": "Sub", "parentId": "s1" })
        )
    );
    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.rename_section("s1".into(), "A".into()).unwrap();
    assert_eq!(
        sent(&s),
        ("PATCH /sections/s1".into(), json!({ "name": "A" }))
    );
    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.set_section_color("s1".into(), "#010203".into())
        .unwrap();
    assert_eq!(sent(&s).1, json!({ "color": "#010203" }));
    s.reply(
        200,
        json!({ "ok": true, "notebookId": "n1", "parentId": "s2", "position": 4.5 }),
    );
    after(&s);
    let m = core
        .move_section("s1".into(), "n1".into(), Some("s2".into()), Some(1))
        .unwrap();
    assert_eq!(
        m,
        SectionPlace {
            notebook_id: "n1".into(),
            parent_id: Some("s2".into()),
            position: 4.5
        }
    );
    assert_eq!(
        sent(&s),
        (
            "POST /sections/s1/move".into(),
            json!({ "index": 1, "notebookId": "n1", "parentId": "s2" })
        )
    );
    s.reply(200, json!({ "id": "s4" }));
    after(&s);
    assert_eq!(core.copy_section("s1".into(), None, None).unwrap(), "s4");
    assert_eq!(sent(&s), ("POST /sections/s1/copy".into(), json!({})));
    s.reply(200, json!({ "ok": true, "trashId": "s1", "tasks": 0 }));
    after(&s);
    core.delete_section("s1".into()).unwrap();
    assert_eq!(sent(&s).0, "DELETE /sections/s1");

    s.reply(200, json!({ "id": "p5" }));
    after(&s);
    core.create_page("s1".into(), Some("Hello".into())).unwrap();
    assert_eq!(sent(&s).1, json!({ "title": "Hello" }));
    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.set_page_icon("p1".into(), Some("*".into())).unwrap();
    assert_eq!(sent(&s), ("PATCH /pages/p1".into(), json!({ "icon": "*" })));
    s.reply(200, json!({ "ok": true }));
    after(&s);
    core.set_page_icon("p1".into(), None).unwrap();
    assert_eq!(sent(&s).1, json!({ "icon": null }));
    s.reply(
        200,
        json!({ "ok": true, "sectionId": "s2", "position": 0.0 }),
    );
    after(&s);
    let m = core
        .move_page("p1".into(), Some("s2".into()), Some(0))
        .unwrap();
    assert_eq!((m.section_id.as_str(), m.position), ("s2", 0.0));
    assert_eq!(
        sent(&s),
        (
            "POST /pages/p1/move".into(),
            json!({ "index": 0, "sectionId": "s2" })
        )
    );
    s.reply(200, json!({ "id": "p6" }));
    after(&s);
    assert_eq!(core.copy_page("p1".into(), None, None).unwrap(), "p6");
    assert_eq!(sent(&s), ("POST /pages/p1/copy".into(), json!({})));
    s.reply(200, json!({ "ok": true, "trashId": "p1", "tasks": 0 }));
    after(&s);
    core.delete_page("p1".into()).unwrap();
    assert_eq!(sent(&s).0, "DELETE /pages/p1");
}

#[test]
fn moving_a_page_between_sections_updates_the_stored_tree() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(
        &s,
        &dir,
        vec![page("p1", "s1", 1.0, false), page("p2", "s1", 2.0, false)],
        vec![],
    );
    s.reply(
        200,
        json!({ "ok": true, "sectionId": "s2", "position": 1.0 }),
    );
    s.reply(
        200,
        tree(
            vec![page("p1", "s2", 1.0, false), page("p2", "s1", 2.0, false)],
            vec![],
        ),
    );
    core.move_page("p1".into(), Some("s2".into()), None)
        .unwrap();
    assert_eq!(titles(&core), ["p1:s2", "p2:s1"]);
}

#[test]
fn trashing_keeps_the_stored_document_and_restoring_and_purging_follow() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    // Open the page once so its document is stored.
    s.reply(200, json!({ "ydoc": "AAA=" }));
    core.page_document("p1".into()).unwrap();
    assert!(core.cached_page_document("p1".into()).is_some());
    s.take();

    // Delete: the page leaves `pages`, appears in the trashed list, and keeps its document.
    s.reply(200, json!({ "ok": true, "trashId": "p1", "tasks": 0 }));
    s.reply(
        200,
        tree(vec![], vec![json!({ "id": "p1", "title": "Page p1" })]),
    );
    core.delete_page("p1".into()).unwrap();
    assert!(core.cached_tree("w1".into()).unwrap().pages.is_empty());
    assert_eq!(
        core.cached_trashed_pages("w1".into()).unwrap(),
        vec![TrashedPage {
            id: "p1".into(),
            title: "Page p1".into()
        }]
    );
    assert!(
        core.cached_page_document("p1".into()).is_some(),
        "a trashed page keeps its stored document"
    );
    s.take();

    // The Trash list (not stored).
    s.reply(
        200,
        json!([{ "kind": "page", "id": "p1", "name": "Page p1", "icon": null, "deletedAt": "2026-11-22T10:00:00.000Z",
                 "deletedBy": "u1", "deletedByName": "Ann", "expiresAt": "2027-01-21T10:00:00.000Z", "daysLeft": 60,
                 "path": "NB n1 > Sec s1", "pages": 0, "sections": 0 }]),
    );
    let t = core.trash("w1".into()).unwrap();
    assert_eq!(t[0].kind, TrashKind::Page);
    assert_eq!(t[0].path, "NB n1 > Sec s1");
    assert_eq!(t[0].days_left, 60);
    assert_eq!(s.take(), [format!("GET {SERVER}/workspaces/w1/trash")]);

    // Restore: back as it was (no movedTo), the page is live again, its document untouched.
    s.reply(200, json!({ "movedTo": "" }));
    s.reply(200, tree(vec![page("p1", "s1", 1.0, false)], vec![]));
    assert_eq!(
        core.restore_from_trash("w1".into(), TrashKind::Page, "p1".into())
            .unwrap(),
        None
    );
    assert_eq!(
        s.take(),
        [
            format!("POST {SERVER}/trash/page/p1/restore"),
            format!("GET {SERVER}/workspaces/w1/tree")
        ]
    );
    assert_eq!(titles(&core), ["p1:s1"]);
    assert!(core.cached_page_document("p1".into()).is_some());

    // Restored somewhere else: the name comes back.
    s.reply(200, json!({ "movedTo": "General" }));
    s.reply(200, tree(vec![page("p1", "s2", 1.0, false)], vec![]));
    assert_eq!(
        core.restore_from_trash("w1".into(), TrashKind::Section, "s1".into())
            .unwrap()
            .as_deref(),
        Some("General")
    );
    s.take();

    // Delete forever: gone from the tree, so the stored document goes too.
    s.reply(200, json!({ "ok": true }));
    s.reply(200, tree(vec![], vec![]));
    core.delete_forever("w1".into(), TrashKind::Page, "p1".into())
        .unwrap();
    assert_eq!(
        s.take(),
        [
            format!("DELETE {SERVER}/trash/page/p1"),
            format!("GET {SERVER}/workspaces/w1/tree")
        ]
    );
    assert_eq!(core.cached_page_document("p1".into()), None);

    // Empty the Trash.
    s.reply(200, json!({ "removed": 3 }));
    s.reply(200, tree(vec![], vec![]));
    assert_eq!(core.empty_trash("w1".into()).unwrap(), 3);
    assert_eq!(s.take()[0], format!("DELETE {SERVER}/workspaces/w1/trash"));
}

#[test]
fn a_page_that_becomes_locked_loses_its_stored_document() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    s.reply(200, json!({ "ydoc": "AAA=" }));
    core.page_document("p1".into()).unwrap();
    assert!(core.cached_page_document("p1".into()).is_some());
    // A move of a page that the refetched tree now shows locked.
    s.reply(
        200,
        json!({ "ok": true, "sectionId": "s2", "position": 1.0 }),
    );
    s.reply(200, tree(vec![page("p1", "s2", 1.0, true)], vec![]));
    core.move_page("p1".into(), Some("s2".into()), None)
        .unwrap();
    assert_eq!(core.cached_page_document("p1".into()), None);
}

#[test]
fn offline_is_an_error_and_the_stored_tree_is_untouched() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    s.fail(1);
    let before = core.cached_tree("w1".into()).unwrap();
    assert!(matches!(
        core.rename_page("p1".into(), "X".into()),
        Err(CoreError::Network { .. })
    ));
    assert_eq!(s.take().len(), 1, "a write is sent once and nothing else");
    assert_eq!(core.cached_tree("w1".into()).unwrap(), before);
    s.fail(1);
    assert!(matches!(
        core.create_section("n1".into(), "x".into(), None, None),
        Err(CoreError::Network { .. })
    ));
    s.fail(3); // a GET is tried three times
    assert!(matches!(
        core.trash("w1".into()),
        Err(CoreError::Network { .. })
    ));
}

#[test]
fn a_refusal_comes_back_as_a_server_error_and_the_tree_is_not_fetched() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    s.reply(400, json!({ "error": "Cannot move between workspaces" }));
    match core.move_page("p1".into(), Some("other".into()), None) {
        Err(CoreError::Server {
            status, message, ..
        }) => {
            assert_eq!(status, 400);
            assert_eq!(message, "Cannot move between workspaces");
        }
        r => panic!("{r:?}"),
    }
    assert_eq!(s.take().len(), 1);
}

#[test]
fn a_failed_refetch_still_reports_the_write_as_done() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    s.reply(200, json!({ "id": "p2" }));
    s.fail(3);
    assert_eq!(core.create_page("s1".into(), None).unwrap(), "p2");
    assert_eq!(titles(&core), ["p1:s1"], "stale until the next tree()");
}

#[test]
fn without_a_store_nothing_is_fetched_after_a_write() {
    let s = Script::default();
    s.reply(200, session());
    let core = Core::with_transport("http://localhost:4417", Box::new(s.clone()), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    s.take();
    s.reply(200, json!({ "id": "p2" }));
    assert_eq!(core.create_page("s1".into(), None).unwrap(), "p2");
    assert_eq!(s.take().len(), 1);
    assert_eq!(core.cached_trashed_pages("w1".into()), None);
}

#[test]
fn an_unknown_id_refreshes_every_stored_tree() {
    let (s, dir) = (Script::default(), TempDir::new());
    let core = core_with(&s, &dir, vec![page("p1", "s1", 1.0, false)], vec![]);
    // A notebook the stored tree does not show: the workspace is not known, so w1's tree is refetched.
    s.reply(200, json!({ "ok": true }));
    s.reply(200, tree(vec![page("p1", "s1", 1.0, false)], vec![]));
    core.rename_notebook("n-new".into(), "X".into()).unwrap();
    assert_eq!(s.take().len(), 2);
}

#[test]
fn position_and_drop_index_follow_the_web() {
    // src/components/shell/treePosition.ts positionAt
    assert_eq!(position_at(vec![], 0), 1.0);
    assert_eq!(position_at(vec![], 5), 1.0);
    assert_eq!(position_at(vec![1.0, 2.0, 4.0], 0), 0.0);
    assert_eq!(position_at(vec![1.0, 2.0, 4.0], 1), 1.5);
    assert_eq!(position_at(vec![1.0, 2.0, 4.0], 2), 3.0);
    assert_eq!(position_at(vec![1.0, 2.0, 4.0], 3), 5.0);
    assert_eq!(position_at(vec![1.0, 2.0, 4.0], 99), 5.0);
    assert_eq!(position_at(vec![3.0], 0), 2.0);
    assert_eq!(position_at(vec![3.0], 1), 4.0);
    // treeDnd.ts indexFor
    let sibs = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    assert_eq!(drop_index(sibs.clone(), "b".into(), false), 1);
    assert_eq!(drop_index(sibs.clone(), "b".into(), true), 2);
    assert_eq!(drop_index(sibs.clone(), "c".into(), true), 3);
    assert_eq!(drop_index(sibs.clone(), "a".into(), false), 0);
    assert_eq!(
        drop_index(sibs.clone(), "zz".into(), false),
        3,
        "no target: the end"
    );
    assert_eq!(drop_index(vec![], "a".into(), true), 0);
}
