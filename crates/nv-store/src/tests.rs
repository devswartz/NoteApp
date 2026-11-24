use super::*;

use std::path::PathBuf;

/// A fresh database path, removed (with its WAL files) when dropped.
struct TempDb(PathBuf);
impl TempDb {
    fn new(name: &str) -> TempDb {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        TempDb(
            std::env::temp_dir().join(format!("nv-store-{name}-{}-{nanos}.db", std::process::id())),
        )
    }
}
impl Drop for TempDb {
    fn drop(&mut self) {
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", self.0.display()));
        }
    }
}

fn workspace(id: &str) -> Workspace {
    Workspace {
        id: id.into(),
        name: format!("Space {id}"),
        role: "owner".into(),
        created_at: "2026-01-01".into(),
    }
}

fn page(id: &str, locked: bool) -> PageMeta {
    PageMeta {
        id: id.into(),
        section_id: "s1".into(),
        title: format!("Page {id}"),
        icon: None,
        kind: "canvas".into(),
        position: 1.0,
        updated_at: "2026-11-01".into(),
        updated_by: None,
        locked,
    }
}

fn tree(pages: Vec<PageMeta>) -> Tree {
    Tree {
        notebooks: vec![Notebook {
            id: "n1".into(),
            workspace_id: "w1".into(),
            name: "Notes".into(),
            color: "#336699".into(),
            visibility: "shared".into(),
            created_by: "u1".into(),
            position: 1.0,
        }],
        sections: vec![Section {
            id: "s1".into(),
            notebook_id: "n1".into(),
            parent_id: None,
            name: "General".into(),
            color: "#996633".into(),
            position: 1.0,
            default_template_id: None,
            no_default_template: false,
        }],
        pages,
        trashed_pages: vec![],
    }
}

fn task(id: &str, locked: bool) -> Task {
    Task {
        id: id.into(),
        workspace_id: "w1".into(),
        title: if locked {
            String::new()
        } else {
            format!("Task {id}")
        },
        description: String::new(),
        status: "open".into(),
        priority: 4,
        due_date: Some("2026-11-30".into()),
        due_time: None,
        recurrence: None,
        reminder_at: None,
        assignee_id: None,
        assigned_by: None,
        completed_by: None,
        created_by: "u1".into(),
        page_id: Some("p1".into()),
        parent_id: None,
        team_id: None,
        tag_ids: vec!["t1".into()],
        checklist: Some(nv_api::Checklist { done: 1, total: 2 }),
        completed_at: None,
        created_at: "2026-11-01".into(),
        updated_at: "2026-11-02".into(),
        locked,
    }
}

#[test]
fn empty_store_has_nothing() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(s.workspaces().unwrap(), None);
    assert_eq!(s.tree("w1").unwrap(), None);
    assert_eq!(s.tasks("w1").unwrap(), None);
    assert_eq!(s.page_doc("p1").unwrap(), None);
    assert_eq!(s.account().unwrap(), None);
}

#[test]
fn round_trips() {
    let s = Store::open_in_memory().unwrap();
    let ws = vec![workspace("w2"), workspace("w1")];
    s.put_workspaces(&ws).unwrap();
    assert_eq!(s.workspaces().unwrap(), Some(ws));
    s.put_workspaces(&[]).unwrap();
    assert_eq!(s.workspaces().unwrap(), Some(vec![]), "stored, but empty");

    s.put_workspaces(&[workspace("w1")]).unwrap();
    let t = tree(vec![page("p2", false), page("p1", false)]);
    s.put_tree("w1", &t).unwrap();
    assert_eq!(s.tree("w1").unwrap(), Some(t));
    assert!(s.stored_at("tree", "w1").unwrap().is_some());
    assert_eq!(s.tree("w2").unwrap(), None);

    let tasks = vec![task("b", false), task("a", true)];
    s.put_tasks("w1", &tasks).unwrap();
    assert_eq!(s.tasks("w1").unwrap(), Some(tasks));
    s.put_tasks("w1", &[task("c", false)]).unwrap();
    assert_eq!(s.tasks("w1").unwrap().unwrap().len(), 1, "replaced");

    let before = now_ms();
    assert!(s.put_page_doc("p1", &[1, 2, 3]).unwrap());
    let doc = s.page_doc("p1").unwrap().unwrap();
    assert_eq!(doc.doc, [1, 2, 3]);
    assert!(doc.stored_at >= before);
    assert!(s.put_page_doc("p1", &[4]).unwrap());
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, [4]);
    s.forget_page("p1").unwrap();
    assert_eq!(s.page_doc("p1").unwrap(), None);
}

#[test]
fn survives_reopening() {
    let db = TempDb::new("reopen");
    {
        let s = Store::open(&db.0).unwrap();
        s.put_workspaces(&[workspace("w1")]).unwrap();
        s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
        s.put_page_doc("p1", b"doc").unwrap();
        s.set_account("u1").unwrap();
    }
    let s = Store::open(&db.0).unwrap();
    assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(s.workspaces().unwrap().unwrap()[0].id, "w1");
    assert_eq!(s.tree("w1").unwrap().unwrap().pages[0].id, "p1");
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, b"doc");
    assert_eq!(s.account().unwrap().as_deref(), Some("u1"));
}

#[test]
fn migrates_an_unversioned_database_and_refuses_a_newer_one() {
    let db = TempDb::new("migrate");
    {
        // A database from before the schema existed: only a meta table, no version.
        let c = Connection::open(&db.0).unwrap();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        assert_eq!(schema_version(&c).unwrap(), 0);
    }
    {
        let s = Store::open(&db.0).unwrap();
        assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
        s.put_workspaces(&[workspace("w1")]).unwrap();
    }
    {
        let c = Connection::open(&db.0).unwrap();
        c.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
            [(SCHEMA_VERSION + 1).to_string()],
        )
        .unwrap();
    }
    match Store::open(&db.0) {
        Err(StoreError::TooNew { found, supported }) => {
            assert_eq!((found, supported), (SCHEMA_VERSION + 1, SCHEMA_VERSION));
        }
        other => panic!("expected TooNew, got {:?}", other.map(|_| ())),
    }
    assert_eq!(
        UPGRADES.len(),
        SCHEMA_VERSION as usize,
        "one upgrade per version"
    );

    // The app's way in: a database it can't use is replaced by an empty one.
    let s = Store::open_or_reset(&db.0).unwrap();
    assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(s.workspaces().unwrap(), None);
}

#[test]
fn a_damaged_file_is_replaced() {
    let db = TempDb::new("damaged");
    std::fs::write(&db.0, [0xAB; 4096]).unwrap();
    assert!(Store::open(&db.0).is_err());
    let s = Store::open_or_reset(&db.0).unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    assert_eq!(s.workspaces().unwrap().unwrap().len(), 1);
}

#[test]
fn locked_pages_are_never_stored() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    // No tree has shown the page yet: it might be locked, so it isn't stored.
    assert!(!s.put_page_doc("p1", b"early").unwrap());
    assert_eq!(s.page_doc("p1").unwrap(), None);
    assert_eq!(s.queue_updates("p1", &[b"edit".to_vec()]).unwrap(), None);
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    assert!(s.put_page_doc("p1", b"early").unwrap());
    assert!(s.put_page_doc("p2", b"secret").unwrap());
    assert!(s
        .queue_updates("p2", &[b"edit".to_vec()])
        .unwrap()
        .is_some());

    // p2 is locked now: its copy goes, and it can't be stored again.
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", true)]))
        .unwrap();
    assert!(s.is_locked("p2").unwrap());
    assert_eq!(s.page_doc("p2").unwrap(), None);
    assert!(
        s.queued_updates("p2").unwrap().is_empty(),
        "queued edits go too"
    );
    assert!(!s.put_page_doc("p2", b"secret").unwrap());
    assert_eq!(s.queue_updates("p2", &[b"edit".to_vec()]).unwrap(), None);
    assert_eq!(s.page_doc("p2").unwrap(), None);
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, b"early");

    // Unlocked again: it may be stored.
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    assert!(!s.is_locked("p2").unwrap());
    assert!(s.put_page_doc("p2", b"open").unwrap());
}

#[test]
fn a_locked_page_in_another_workspace_is_dropped_too() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1"), workspace("w2")])
        .unwrap();
    // Stored as a page of w1, then a tree of w2 shows it locked.
    s.put_tree("w1", &tree(vec![page("p9", false)])).unwrap();
    assert!(s.put_page_doc("p9", b"secret").unwrap());
    s.put_tree("w2", &tree(vec![page("p9", true)])).unwrap();
    assert_eq!(s.page_doc("p9").unwrap(), None);
}

#[test]
fn pages_gone_from_the_tree_and_workspaces_gone_are_pruned() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1"), workspace("w2")])
        .unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    s.put_tree("w2", &tree(vec![page("q1", false)])).unwrap();
    s.put_tasks("w2", &[task("t", false)]).unwrap();
    for p in ["p1", "p2", "q1"] {
        assert!(s.put_page_doc(p, b"x").unwrap());
    }
    assert!(!s.put_page_doc("loose", b"x").unwrap(), "in no tree");

    s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
    assert!(s.page_doc("p1").unwrap().is_some());
    assert_eq!(s.page_doc("p2").unwrap(), None, "no longer in w1's tree");
    assert!(s.page_doc("q1").unwrap().is_some(), "another workspace's");

    s.put_workspaces(&[workspace("w1")]).unwrap();
    assert_eq!(s.tree("w2").unwrap(), None);
    assert_eq!(s.tasks("w2").unwrap(), None);
    assert_eq!(s.page_doc("q1").unwrap(), None);
}

#[test]
fn one_task_is_replaced_in_place_or_added_last() {
    let s = Store::open_in_memory().unwrap();
    s.put_tasks("w1", &[task("a", false), task("b", false)])
        .unwrap();
    let mut a = task("a", false);
    a.status = "done".into();
    s.put_task(&a).unwrap();
    s.put_task(&task("c", false)).unwrap();
    let got = s.tasks("w1").unwrap().unwrap();
    assert_eq!(
        got.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        ["a", "b", "c"]
    );
    assert_eq!(got[0].status, "done");
}

#[test]
fn locked_tasks_are_kept_as_sent() {
    let s = Store::open_in_memory().unwrap();
    s.put_tasks("w1", &[task("a", true)]).unwrap();
    let got = s.tasks("w1").unwrap().unwrap();
    assert!(got[0].locked);
    assert_eq!(got[0].title, "");
}

#[test]
fn clear_drops_everything() {
    let db = TempDb::new("clear");
    let s = Store::open(&db.0).unwrap();
    s.set_account("u1").unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
    s.put_tasks("w1", &[task("a", false)]).unwrap();
    s.put_page_doc("p1", b"doc").unwrap();
    s.queue_updates("p1", &[b"edit".to_vec()]).unwrap().unwrap();
    s.clear().unwrap();
    assert!(s.queued_pages().unwrap().is_empty());
    assert_eq!(s.workspaces().unwrap(), None);
    assert_eq!(s.tree("w1").unwrap(), None);
    assert_eq!(s.tasks("w1").unwrap(), None);
    assert_eq!(s.page_doc("p1").unwrap(), None);
    assert_eq!(s.account().unwrap(), None);
    assert!(!s.is_locked("p1").unwrap());
    assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    drop(s);
    let s = Store::open(&db.0).unwrap();
    assert_eq!(s.workspaces().unwrap(), None);
}

#[test]
fn another_account_clears_the_store() {
    let s = Store::open_in_memory().unwrap();
    assert!(!s.set_account("u1").unwrap());
    s.put_workspaces(&[workspace("w1")]).unwrap();
    assert!(!s.set_account("u1").unwrap());
    assert!(s.workspaces().unwrap().is_some());
    assert!(s.set_account("u2").unwrap());
    assert_eq!(s.workspaces().unwrap(), None);
    assert_eq!(s.account().unwrap().as_deref(), Some("u2"));
}

#[test]
fn shared_between_threads() {
    let s = std::sync::Arc::new(Store::open_in_memory().unwrap());
    let pages = (0..4)
        .flat_map(|i| (0..10).map(move |j| page(&format!("p{i}-{j}"), false)))
        .collect();
    s.put_tree("w1", &tree(pages)).unwrap();
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let s = s.clone();
            std::thread::spawn(move || {
                for j in 0..10 {
                    assert!(s
                        .put_page_doc(&format!("p{i}-{j}"), &[i as u8, j as u8])
                        .unwrap());
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(s.page_doc("p3-9").unwrap().unwrap().doc, [3, 9]);
}

#[test]
fn the_outbox_keeps_edits_until_unqueued() {
    let db = TempDb::new("outbox");
    {
        let s = Store::open(&db.0).unwrap();
        s.put_workspaces(&[workspace("w1")]).unwrap();
        s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
            .unwrap();
        let k1 = s
            .queue_updates("p1", &[b"a".to_vec(), b"b".to_vec()])
            .unwrap()
            .unwrap();
        let k2 = s.queue_updates("p2", &[b"x".to_vec()]).unwrap().unwrap();
        assert_eq!(k1.len(), 2);
        assert!(k1[0] < k1[1] && k1[1] < k2[0], "keys grow");
        assert_eq!(s.queued_pages().unwrap(), ["p1", "p2"]);
        s.unqueue("p1", &k1[..1]).unwrap();
        s.unqueue("p2", &k1[1..]).unwrap(); // another page's key: nothing happens
    }
    // Survives reopening (an app restart).
    let s = Store::open(&db.0).unwrap();
    assert_eq!(s.queued_updates("p1").unwrap()[0].1, b"b");
    assert_eq!(s.queued_updates("p1").unwrap().len(), 1);
    assert_eq!(s.queued_updates("p2").unwrap()[0].1, b"x");
    // Access ended: forgotten with the page.
    s.forget_page("p2").unwrap();
    assert!(s.queued_updates("p2").unwrap().is_empty());
    assert_eq!(s.queued_pages().unwrap(), ["p1"]);
    assert_eq!(s.last_error(), None);
}

#[test]
fn upgrades_a_version_1_database_in_place() {
    let db = TempDb::new("v1");
    {
        // A database as the version 1 app left it.
        let mut c = Connection::open(&db.0).unwrap();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        let tx = c.transaction().unwrap();
        upgrade_to_1(&tx).unwrap();
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('account', 'u1')",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO page_docs (page_id, workspace_id, doc, stored_at) VALUES ('p1', 'w1', x'0102', 5)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(
            c.prepare("SELECT * FROM outbox").is_err(),
            "no outbox in version 1"
        );
    }
    let s = Store::open(&db.0).unwrap();
    assert_eq!(s.schema_version().unwrap(), SCHEMA_VERSION);
    assert_eq!(s.account().unwrap().as_deref(), Some("u1"), "data kept");
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, [1, 2]);
    s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
    assert!(s.queue_updates("p1", &[b"e".to_vec()]).unwrap().is_some());
    assert_eq!(s.queued_updates("p1").unwrap().len(), 1);
}

#[test]
fn a_failed_write_is_remembered() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.last_error(), None);
    s.conn().execute_batch("DROP TABLE outbox").unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false)]))
        .unwrap_err();
    assert!(s.last_error().unwrap().contains("outbox"));
}

fn subtask(id: &str, parent: &str) -> Task {
    Task {
        parent_id: Some(parent.into()),
        ..task(id, false)
    }
}

#[test]
fn a_task_is_found_by_id_and_removed_with_its_subtasks() {
    let s = Store::open_in_memory().unwrap();
    let tasks = [
        task("a", false),
        subtask("a1", "a"),
        subtask("a1x", "a1"),
        task("b", false),
    ];
    s.put_tasks("w1", &tasks).unwrap();
    assert_eq!(s.task("a1").unwrap().unwrap().title, "Task a1");
    assert_eq!(s.task("nope").unwrap(), None);
    let gone: Vec<String> = s
        .remove_task("a")
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(gone, ["a", "a1", "a1x"]);
    let left: Vec<String> = s
        .tasks("w1")
        .unwrap()
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(left, ["b"]);
    assert!(s.remove_task("a").unwrap().is_empty());
}

#[test]
fn task_changes_queue_in_order_and_follow_the_locked_page_rules() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", true)]))
        .unwrap();
    let create = TaskOp::Create {
        task: Box::new(nv_api::NewTask {
            id: Some("t1".into()),
            title: "Call Bo".into(),
            page_id: Some("p1".into()),
            ..Default::default()
        }),
    };
    let rename = TaskOp::Update {
        patch: serde_json::json!({ "title": "Call Bo back" }),
    };
    let a = s.queue_task_op("w1", "t1", Some("p1"), &create).unwrap();
    let b = s.queue_task_op("w1", "t1", Some("p1"), &rename).unwrap();
    let c = s.queue_task_op("w1", "t9", None, &TaskOp::Delete).unwrap();
    assert!(a < b && b < c);
    // A locked page, or one no stored tree shows: not kept.
    assert_eq!(
        s.queue_task_op("w1", "t2", Some("p2"), &TaskOp::Delete)
            .unwrap(),
        None
    );
    assert_eq!(
        s.queue_task_op("w1", "t3", Some("p-unknown"), &TaskOp::Delete)
            .unwrap(),
        None
    );
    let ops = s.task_ops().unwrap();
    assert_eq!(
        ops.iter().map(|o| &o.op).collect::<Vec<_>>(),
        [&create, &rename, &TaskOp::Delete]
    );
    assert_eq!(ops[2].task_id, "t9");
    s.unqueue_task_op(ops[0].seq).unwrap();
    assert_eq!(s.task_ops().unwrap().len(), 2);

    // The page becomes locked: its task changes go; the standalone one stays.
    s.put_tree("w1", &tree(vec![page("p1", true)])).unwrap();
    let ops = s.task_ops().unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].task_id, "t9");
    s.clear().unwrap();
    assert!(s.task_ops().unwrap().is_empty());
}

#[test]
fn upgrades_a_version_2_database_in_place() {
    let db = TempDb::new("v2");
    {
        let mut c = Connection::open(&db.0).unwrap();
        c.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .unwrap();
        let tx = c.transaction().unwrap();
        upgrade_to_1(&tx).unwrap();
        upgrade_to_2(&tx).unwrap();
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', '2'), ('account', 'u1')",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO outbox (page_id, update_v1, queued_at) VALUES ('p1', x'01', 5)",
            [],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let s = Store::open(&db.0).unwrap();
    assert_eq!(s.schema_version().unwrap(), 3);
    assert_eq!(s.queued_updates("p1").unwrap().len(), 1, "data kept");
    s.queue_task_op("w1", "t1", None, &TaskOp::Delete).unwrap();
    assert_eq!(s.task_ops().unwrap().len(), 1);
}

#[test]
fn a_trashed_page_keeps_its_document_until_it_is_gone_for_good() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    assert!(s.put_page_doc("p1", b"one").unwrap());
    assert!(s.put_page_doc("p2", b"two").unwrap());

    // p1 goes to the Trash: out of `pages`, into `trashed_pages`; its document stays.
    let mut t = tree(vec![page("p2", false)]);
    t.trashed_pages = vec![nv_api::TrashedPage {
        id: "p1".into(),
        title: "One".into(),
    }];
    s.put_tree("w1", &t).unwrap();
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, b"one");
    assert_eq!(s.tree("w1").unwrap(), Some(t));
    // It is not a live page: nothing new is stored for it, and it has no workspace as a page.
    assert!(!s.put_page_doc("p1", b"new").unwrap());
    assert_eq!(s.workspace_of("page", "p1").unwrap(), None);
    assert_eq!(s.workspace_of("page", "p2").unwrap().as_deref(), Some("w1"));

    // Restored: back in `pages`, document untouched.
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    assert_eq!(s.page_doc("p1").unwrap().unwrap().doc, b"one");
    assert!(s.tree("w1").unwrap().unwrap().trashed_pages.is_empty());

    // Trashed, then deleted for good: gone from both lists, so the document goes.
    let mut t = tree(vec![page("p2", false)]);
    t.trashed_pages = vec![nv_api::TrashedPage {
        id: "p1".into(),
        title: "One".into(),
    }];
    s.put_tree("w1", &t).unwrap();
    s.put_tree("w1", &tree(vec![page("p2", false)])).unwrap();
    assert_eq!(s.page_doc("p1").unwrap(), None);
    assert!(s.page_doc("p2").unwrap().is_some());
}

#[test]
fn the_store_knows_which_workspace_holds_a_node() {
    let s = Store::open_in_memory().unwrap();
    assert_eq!(s.tree_workspaces().unwrap(), Vec::<String>::new());
    s.put_workspaces(&[workspace("w1")]).unwrap();
    s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
    assert_eq!(s.tree_workspaces().unwrap(), ["w1"]);
    assert_eq!(
        s.workspace_of("notebook", "n1").unwrap().as_deref(),
        Some("w1")
    );
    assert_eq!(
        s.workspace_of("section", "s1").unwrap().as_deref(),
        Some("w1")
    );
    assert_eq!(s.workspace_of("page", "p1").unwrap().as_deref(), Some("w1"));
    assert_eq!(s.workspace_of("page", "nope").unwrap(), None);
}

// ───────── Tasks on locked pages ─────────

fn full_task(id: &str, page: &str) -> Task {
    let mut t = task(id, false);
    t.page_id = Some(page.into());
    t.title = format!("SECRET {id}");
    t.description = "SECRET text".into();
    t
}

#[test]
fn tasks_on_a_locked_page_are_stored_redacted_however_they_arrive() {
    let store = Store::open_in_memory().unwrap();
    store
        .put_tree("w1", &tree(vec![page("p1", true), page("p2", false)]))
        .unwrap();
    // A whole list (the server sent them in full: the sign-in was unlocked).
    store
        .put_tasks("w1", &[full_task("a", "p1"), full_task("b", "p2")])
        .unwrap();
    // One task (a write's answer).
    store.put_task(&full_task("c", "p1")).unwrap();
    let got = store.tasks("w1").unwrap().unwrap();
    let by = |id: &str| got.iter().find(|t| t.id == id).unwrap();
    for id in ["a", "c"] {
        let t = by(id);
        assert_eq!(
            (t.title.as_str(), t.description.as_str(), t.locked),
            ("Locked task", "", true)
        );
        assert!(t.tag_ids.is_empty());
        assert_eq!(t.due_date.as_deref(), Some("2026-11-30"), "the rest stays");
        assert_eq!(t.checklist, Some(nv_api::Checklist { done: 1, total: 2 }));
    }
    assert_eq!(
        (by("b").title.as_str(), by("b").locked),
        ("SECRET b", false)
    );
    assert_eq!(store.task("c").unwrap().unwrap().title, "Locked task");
}

#[test]
fn a_page_that_becomes_locked_redacts_the_tasks_stored_before() {
    let store = Store::open_in_memory().unwrap();
    store
        .put_tree("w1", &tree(vec![page("p1", false)]))
        .unwrap();
    store.put_tasks("w1", &[full_task("a", "p1")]).unwrap();
    store.put_page_doc("p1", b"doc").unwrap();
    assert_eq!(store.tasks("w1").unwrap().unwrap()[0].title, "SECRET a");

    // The next tree load says it is locked.
    store.put_tree("w1", &tree(vec![page("p1", true)])).unwrap();
    assert_eq!(store.tasks("w1").unwrap().unwrap()[0].title, "Locked task");
    assert!(store.page_doc("p1").unwrap().is_none());

    // Or the core marks it at once (it locked the page itself).
    let store = Store::open_in_memory().unwrap();
    store
        .put_tree("w1", &tree(vec![page("p1", false)]))
        .unwrap();
    store.put_tasks("w1", &[full_task("a", "p1")]).unwrap();
    store.put_page_doc("p1", b"doc").unwrap();
    store.queue_updates("p1", &[b"edit".to_vec()]).unwrap();
    assert!(store.mark_page_locked("p1").unwrap());
    assert!(store.is_locked("p1").unwrap());
    assert!(store.tree("w1").unwrap().unwrap().pages[0].locked);
    assert_eq!(store.tasks("w1").unwrap().unwrap()[0].title, "Locked task");
    assert!(store.page_doc("p1").unwrap().is_none());
    assert!(store.queued_updates("p1").unwrap().is_empty());
    assert!(!store.mark_page_locked("nope").unwrap());
}

#[test]
fn a_locked_pages_text_is_gone_from_the_file_after_it_is_locked() {
    let db = TempDb::new("lockedbytes");
    let store = Store::open(&db.0).unwrap();
    store
        .put_tree("w1", &tree(vec![page("p1", false)]))
        .unwrap();
    store.put_tasks("w1", &[full_task("a", "p1")]).unwrap();
    store.put_page_doc("p1", b"SECRET page body").unwrap();
    store.mark_page_locked("p1").unwrap();
    drop(store);
    let mut all = Vec::new();
    for ext in ["", "-wal", "-shm"] {
        if let Ok(b) = std::fs::read(format!("{}{ext}", db.0.display())) {
            all.extend(b);
        }
    }
    let has = |n: &str| all.windows(n.len()).any(|w| w == n.as_bytes());
    assert!(!has("SECRET"), "text of a locked page is still in the file");
    assert!(has("Locked task"));
}
