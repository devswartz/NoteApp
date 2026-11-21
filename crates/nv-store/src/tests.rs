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
        }],
        pages,
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
        assert_eq!(s.schema_version().unwrap(), 1);
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
}

#[test]
fn locked_pages_are_never_stored() {
    let s = Store::open_in_memory().unwrap();
    s.put_workspaces(&[workspace("w1")]).unwrap();
    // Stored before any tree showed the page, then before it was locked.
    assert!(s.put_page_doc("p1", b"early").unwrap());
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", false)]))
        .unwrap();
    assert!(s.put_page_doc("p2", b"secret").unwrap());
    assert!(s.page_doc("p1").unwrap().is_some());

    // p2 is locked now: its copy goes, and it can't be stored again.
    s.put_tree("w1", &tree(vec![page("p1", false), page("p2", true)]))
        .unwrap();
    assert!(s.is_locked("p2").unwrap());
    assert_eq!(s.page_doc("p2").unwrap(), None);
    assert!(!s.put_page_doc("p2", b"secret").unwrap());
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
    // Stored with no tree known, then a tree of w2 shows it locked.
    s.put_page_doc("p9", b"secret").unwrap();
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
        s.put_page_doc(p, b"x").unwrap();
    }
    s.put_page_doc("loose", b"x").unwrap();

    s.put_tree("w1", &tree(vec![page("p1", false)])).unwrap();
    assert!(s.page_doc("p1").unwrap().is_some());
    assert_eq!(s.page_doc("p2").unwrap(), None, "no longer in w1's tree");
    assert!(s.page_doc("q1").unwrap().is_some(), "another workspace's");

    s.put_workspaces(&[workspace("w1")]).unwrap();
    assert_eq!(s.tree("w2").unwrap(), None);
    assert_eq!(s.tasks("w2").unwrap(), None);
    assert_eq!(s.page_doc("q1").unwrap(), None);
    assert!(
        s.page_doc("loose").unwrap().is_some(),
        "not known to be in w2"
    );
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
    s.clear().unwrap();
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
    let handles: Vec<_> = (0..4)
        .map(|i| {
            let s = s.clone();
            std::thread::spawn(move || {
                for j in 0..10 {
                    s.put_page_doc(&format!("p{i}-{j}"), &[i as u8, j as u8])
                        .unwrap();
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(s.page_doc("p3-9").unwrap().unwrap().doc, [3, 9]);
}
