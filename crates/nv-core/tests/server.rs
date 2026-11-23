//! The Core API against a real server (today's Node server), end to end: register, list
//! workspaces, tree and tasks, write a task, open a page live, edit it, see the edit from a
//! second sign-in and in the server's saved copy, refresh and sign out.
//!
//! Skipped unless NV_TEST_SERVER is set to a server that allows sign-ups and sends no mail, e.g.
//!   PORT=4417 DATA_DIR=<temp> JWT_SECRET=<32+ chars> SIGNUP_MODE=open npx tsx server/index.ts
//!   NV_TEST_SERVER=http://127.0.0.1:4417 cargo test -p nv-core --test server

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nv_core::*;
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{
    ReadTxn, Transact, Update, WriteTxn, Xml, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<SyncStatus>>,
    changes: Mutex<Vec<PageInfo>>,
}
impl PageListener for Events {
    fn on_status(&self, s: SyncStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, p: PageInfo) {
        self.changes.lock().unwrap().push(p);
    }
}

#[derive(Default)]
struct LiveEvents {
    statuses: Mutex<Vec<LiveStatus>>,
}
impl LivePageListener for LiveEvents {
    fn on_status(&self, s: LiveStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {}
}

fn wait_for(what: &str, secs: u64, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(secs),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A Yjs update that adds a paragraph to the end of the page's main fragment.
fn add_paragraph(document: &[u8], fragment: &str, text: &str) -> Vec<u8> {
    let doc = nv_model::doc_from_update(document).unwrap();
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let frag = txn.get_or_insert_xml_fragment(fragment);
        let len = frag.len(&txn);
        let p = frag.insert(&mut txn, len, XmlElementPrelim::empty("paragraph"));
        p.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    let u = doc.transact().encode_state_as_update_v1(&before);
    assert!(Update::decode_v1(&u).is_ok());
    u
}

#[test]
fn core_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let email = format!("core-test-{stamp}@example.com");
    let password = "correct horse battery staple 1";

    let core = Core::new(url.clone());
    assert_eq!(core.workspaces().unwrap_err(), CoreError::SignedOut);
    let me = core
        .register("Core Test".into(), email.clone(), password.into())
        .unwrap();
    assert!(
        me.user.email_verified,
        "the test server must not need email verification"
    );
    assert!(matches!(
        core.sign_in(email.clone(), "wrong password".into()),
        Err(CoreError::Server { status: 401, .. })
    ));

    // Workspaces, tree, tasks.
    let ws = core.workspaces().unwrap();
    let w = &ws[0];
    assert_eq!(w.role, "owner");
    let tree = core.tree(w.id.clone()).unwrap();
    assert!(
        !tree.notebooks.is_empty() && !tree.pages.is_empty(),
        "a new workspace has its onboarding pages"
    );
    let t = core
        .create_task(w.id.clone(), "From the Rust core".into(), None)
        .unwrap();
    assert!(!t.done);
    assert!(core
        .tasks(w.id.clone())
        .unwrap()
        .iter()
        .any(|x| x.id == t.id));
    assert!(core.set_task_done(t.id.clone(), true).unwrap().done);

    // A task on a page with the client's id (as the editor makes them), created again (a
    // retry: the same task), renamed, deleted (with its subtask), restored, deleted again.
    let page = &tree.pages[0];
    let id = new_task_id();
    let on_page = |id: &str, title: &str| NewTaskInput {
        id: Some(id.into()),
        title: title.into(),
        page_id: Some(page.id.clone()),
        parent_id: None,
        done: false,
        ..Default::default()
    };
    let made = core
        .create_task_with(w.id.clone(), on_page(&id, ""))
        .unwrap();
    assert_eq!(
        (made.id.as_str(), made.page_id.as_deref()),
        (id.as_str(), Some(page.id.as_str()))
    );
    let again = core
        .create_task_with(w.id.clone(), on_page(&id, "ignored"))
        .unwrap();
    assert_eq!((again.id, again.title), (id.clone(), String::new()));
    let renamed = core
        .set_task_title(id.clone(), "  Named by the core  ".into())
        .unwrap();
    assert_eq!(renamed.title, "Named by the core", "trimmed");
    let sub_id = new_task_id();
    let sub = core
        .create_task_with(
            w.id.clone(),
            NewTaskInput {
                parent_id: Some(id.clone()),
                page_id: None,
                done: true,
                ..on_page(&sub_id, "Sub")
            },
        )
        .unwrap();
    assert!(sub.done && sub.parent_id.as_deref() == Some(id.as_str()));
    let listed = |core: &Core| -> Vec<String> {
        core.tasks(w.id.clone())
            .unwrap()
            .into_iter()
            .map(|t| t.id)
            .filter(|x| *x == id || *x == sub_id)
            .collect()
    };
    assert_eq!(listed(&core).len(), 2);
    core.delete_task(id.clone()).unwrap();
    assert!(listed(&core).is_empty(), "the subtask went too");
    core.delete_task(id.clone()).unwrap(); // already gone: fine
                                           // Restoring needs the stored copy: a Core without a store can't.
    assert!(!core.restore_task(id.clone()).unwrap());
    let stored_dir = std::env::temp_dir().join(format!("nv-core-server-{stamp}"));
    let with_store = Core::with_store(
        url.clone(),
        stored_dir.join("s.db").to_string_lossy().into(),
    );
    with_store.sign_in(email.clone(), password.into()).unwrap();
    with_store.tree(w.id.clone()).unwrap();
    with_store
        .create_task_with(w.id.clone(), on_page(&id, "Back again"))
        .unwrap();
    with_store.tasks(w.id.clone()).unwrap();
    with_store.delete_task(id.clone()).unwrap();
    assert!(with_store.restore_task(id.clone()).unwrap());
    let back = with_store.cached_task(id.clone()).unwrap();
    assert_eq!(
        (back.title.as_str(), back.page_id.as_deref()),
        ("Back again", Some(page.id.as_str()))
    );
    assert!(listed(&with_store).contains(&id));
    with_store.delete_task(id.clone()).unwrap();
    assert_eq!(with_store.unsent_task_changes(), 0);
    assert_eq!(with_store.task_error(), None);
    with_store.sign_out();
    let _ = std::fs::remove_dir_all(&stored_dir);

    // A page: its saved document, then live.
    let saved = read_page(core.page_document(page.id.clone()).unwrap()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_page(page.id.clone(), ev.clone()).unwrap();
    wait_for("sync", 10, || {
        ev.statuses.lock().unwrap().contains(&SyncStatus::Synced)
    });
    assert_eq!(live.info().text, saved.text);
    assert!(!ev.changes.lock().unwrap().is_empty());
    live.announce_presence(true);

    // Edit the page from here.
    let main = live
        .info()
        .boxes
        .first()
        .map(|b| format!("box:{}", b.id))
        .unwrap_or_else(|| "default".into());
    let marker = format!("Written by the Rust core {stamp}");
    live.apply_update(add_paragraph(&live.document(), &main, &marker))
        .unwrap();
    assert!(live.info().text.contains(&marker));

    // A second sign-in (opening the page the newer, non-blocking way) sees it live, and sees
    // the first one's presence.
    let other = Core::new(url.clone());
    other.sign_in(email.clone(), password.into()).unwrap();
    let ev2 = Arc::new(LiveEvents::default());
    let live2 = other.open_live_page(page.id.clone(), ev2.clone()).unwrap();
    wait_for("the second sign-in to sync", 10, || {
        ev2.statuses.lock().unwrap().contains(&LiveStatus::Synced)
    });
    wait_for("the second sign-in to see the edit", 10, || {
        live2.info().text.contains(&marker)
    });
    wait_for("presence", 10, || {
        live2.presence().iter().any(|p| p.contains("Core Test"))
    });

    // ...and its edits reach the first.
    let reply = format!("Reply {stamp}");
    live2
        .apply_update(add_paragraph(&live2.document(), &main, &reply))
        .unwrap();
    wait_for("the server's receipt", 10, || live2.unsent_updates() == 0);
    wait_for("the first sign-in to see the reply", 10, || {
        ev.changes
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.text.contains(&reply))
    });

    // The server saves it (debounced) and indexes it.
    wait_for("the server to save the page", 15, || {
        read_page(core.page_document(page.id.clone()).unwrap())
            .map(|p| p.text.contains(&marker) && p.text.contains(&reply))
            .unwrap_or(false)
    });

    // Boxes: one created on the second sign-in appears on the first, takes typing through an
    // editor session, and is moved and widened; the server saves all of it as the web would.
    let box_id = live2.create_box(210.0, 330.0, 360.0, 1000.0).unwrap();
    wait_for("the first sign-in to see the new box", 10, || {
        live.info().boxes.iter().any(|b| b.id == box_id)
    });
    let session = EditorSession::open_live(
        live2.clone(),
        format!("box:{box_id}"),
        Arc::new(NoTaskCallbacks),
    )
    .unwrap();
    for c in format!("Boxed {stamp}").chars() {
        session.insert_text(c.to_string());
    }
    live2.move_box(box_id.clone(), 250.0, 400.0).unwrap();
    live2.resize_box(box_id.clone(), 480.0).unwrap();
    live2.bring_to_front(box_id.clone()).unwrap();
    wait_for("the server's receipt for the box", 10, || {
        live2.unsent_updates() == 0
    });
    wait_for("the first sign-in to see the box moved", 10, || {
        live.info()
            .boxes
            .iter()
            .any(|b| b.id == box_id && b.x == 250.0 && b.y == 400.0 && b.w == 480.0)
    });
    wait_for("the server to save the box", 15, || {
        read_page(core.page_document(page.id.clone()).unwrap())
            .map(|p| {
                p.boxes
                    .iter()
                    .any(|b| b.id == box_id && b.x == 250.0 && b.w == 480.0 && !b.wide)
                    && p.text.contains(&format!("Boxed {stamp}"))
            })
            .unwrap_or(false)
    });
    drop(session);
    live2.delete_box_with_content(box_id.clone()).unwrap();
    wait_for("the first sign-in to see the box deleted", 10, || {
        !live.info().boxes.iter().any(|b| b.id == box_id)
    });
    live.close();
    live2.close();
    assert!(matches!(
        ev2.statuses.lock().unwrap().last(),
        Some(LiveStatus::Ended {
            reason: LiveEnd::Closed,
            ..
        })
    ));
    assert_eq!(
        ev.statuses.lock().unwrap().last(),
        Some(&SyncStatus::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );

    // Sessions: restore from the stored refresh token; after sign-out it no longer works.
    let token = core.refresh_token().unwrap();
    let again = Core::new(url.clone());
    assert_eq!(again.restore_session(token).unwrap().user.id, me.user.id);
    let rotated = again.refresh_token().unwrap();
    again.sign_out();
    assert_eq!(
        Core::new(url).restore_session(rotated).unwrap_err(),
        CoreError::SignedOut
    );
}

/// No tasks are made in the box test above.
struct NoTaskCallbacks;
impl TaskCallbacks for NoTaskCallbacks {
    fn new_id(&self) -> String {
        new_task_id()
    }
    fn create(&self, _: String, _: String, _: bool) {}
    fn delete(&self, _: String) {}
    fn restore(&self, _: String) -> bool {
        true
    }
    fn title(&self, _: String) -> Option<String> {
        None
    }
    fn set_title(&self, _: String, _: String) {}
}

/// Every task field, set and cleared through `update_task` and read back, then tags, members,
/// reminders, notes and quick add, against the real server (docs/rewrite/status/core.md, "For
/// apple: task details").
#[test]
fn task_details_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let core = Core::new(url);
    let me = core
        .register(
            "Detail Test".into(),
            format!("detail-test-{stamp}@example.com"),
            "correct horse battery staple 1".into(),
        )
        .unwrap()
        .user;
    let ws = core.workspaces().unwrap()[0].id.clone();
    let read = |id: &str| -> TaskDetail {
        core.task_details(ws.clone())
            .unwrap()
            .into_iter()
            .find(|t| t.id == id)
            .unwrap_or_else(|| panic!("task {id} isn't listed"))
    };
    let ch = TaskChanges::default;

    // Quick add decides the fields of a new task; the tag is made by name first.
    let q = parse_quick_add(
        "Call Sam tomorrow 3pm p2 @me #waiting every 2 weeks on mon,thu".into(),
        "2026-11-05".into(),
    );
    assert_eq!(q.title, "Call Sam");
    let tag = core
        .create_tag(ws.clone(), q.tags[0].clone(), None)
        .unwrap();
    assert_eq!(tag.name, "waiting");
    let members = core.members(ws.clone()).unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(
        resolve_member("me".into(), members.clone(), me.id.clone()).as_deref(),
        Some(me.id.as_str())
    );
    let id = new_task_id();
    let made = core
        .create_task_with(
            ws.clone(),
            NewTaskInput {
                id: Some(id.clone()),
                title: q.title.clone(),
                priority: q.priority,
                due_date: q.due_date.clone(),
                due_time: q.due_time.clone(),
                recurrence: q.recurrence.clone(),
                assignee_id: Some(me.id.clone()),
                tag_ids: Some(vec![tag.id.clone()]),
                description: Some("From quick add".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(made.priority, 2);
    let d = read(&id);
    assert_eq!(
        (
            d.title.as_str(),
            d.description.as_str(),
            d.priority,
            d.due_date.as_deref(),
            d.due_time.as_deref()
        ),
        (
            "Call Sam",
            "From quick add",
            2,
            Some("2026-11-06"),
            Some("15:00")
        )
    );
    let rule = d.recurrence.clone().unwrap();
    assert_eq!(
        (rule.freq.as_str(), rule.interval, rule.by_weekday.clone()),
        ("week", Some(2), Some(vec![1, 4]))
    );
    assert_eq!(
        (
            d.assignee_id.as_deref(),
            d.assigned_by.as_deref(),
            d.created_by.as_str()
        ),
        (Some(me.id.as_str()), Some(me.id.as_str()), me.id.as_str())
    );
    assert_eq!(d.tag_ids, [tag.id.as_str()]);
    assert_eq!(
        describe_recurrence(rule, d.due_date.clone()),
        "Every 2 weeks on Mon, Thu"
    );

    // Set everything else, one read back after each group.
    let u = core
        .update_task(
            id.clone(),
            TaskChanges {
                title: Some("  Call Sam Jones ".into()),
                description: Some("Ring before noon".into()),
                priority: Some(1),
                due_date: Some("2026-12-24".into()),
                due_time: Some("08:15".into()),
                reminder_at: Some("2026-12-24T07:00:00.000Z".into()),
                recurrence: Some(TaskRecurrence {
                    by_month_day: Some(-1),
                    ..first_rule("month")
                }),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        (u.title.as_str(), u.priority, u.due_time.as_deref()),
        ("Call Sam Jones", 1, Some("08:15"))
    );
    let d = read(&id);
    assert_eq!(
        (
            d.description.as_str(),
            d.due_date.as_deref(),
            d.reminder_at.as_deref()
        ),
        (
            "Ring before noon",
            Some("2026-12-24"),
            Some("2026-12-24T07:00:00.000Z")
        )
    );
    let rule = d.recurrence.clone().unwrap();
    assert_eq!((rule.freq.as_str(), rule.by_month_day), ("month", Some(-1)));
    assert_eq!(
        describe_recurrence(rule, d.due_date.clone()),
        "Every month on the last day"
    );

    // Clear what can be cleared.
    let c = core
        .update_task(
            id.clone(),
            TaskChanges {
                clear_due_time: true,
                clear_recurrence: true,
                clear_reminder_at: true,
                clear_assignee: true,
                tag_ids: Some(vec![]),
                description: Some(String::new()),
                ..ch()
            },
        )
        .unwrap();
    assert_eq!(
        (c.due_time, c.recurrence, c.reminder_at, c.assignee_id),
        (None, None, None, None)
    );
    let d = read(&id);
    assert_eq!(
        (d.assigned_by, d.tag_ids.len(), d.description.as_str()),
        (None, 0, "")
    );
    assert_eq!(d.due_date.as_deref(), Some("2026-12-24"));
    core.update_task(
        id.clone(),
        TaskChanges {
            clear_due_date: true,
            ..ch()
        },
    )
    .unwrap();
    assert_eq!(read(&id).due_date, None);

    // Tick it: who and when; reopen it.
    let t = core
        .update_task(
            id.clone(),
            TaskChanges {
                done: Some(true),
                ..ch()
            },
        )
        .unwrap();
    assert!(t.done && t.completed_at.is_some());
    assert_eq!(t.completed_by.as_deref(), Some(me.id.as_str()));
    let t = core
        .update_task(
            id.clone(),
            TaskChanges {
                done: Some(false),
                ..ch()
            },
        )
        .unwrap();
    assert!(!t.done && t.completed_at.is_none() && t.completed_by.is_none());

    // A recurring task ticked comes back open with its next date.
    let rid = new_task_id();
    core.create_task_with(
        ws.clone(),
        NewTaskInput {
            id: Some(rid.clone()),
            title: "Water plants".into(),
            due_date: Some("2026-01-05".into()),
            recurrence: Some(first_rule("week")),
            ..Default::default()
        },
    )
    .unwrap();
    let t = core
        .update_task(
            rid.clone(),
            TaskChanges {
                done: Some(true),
                ..ch()
            },
        )
        .unwrap();
    assert!(!t.done, "a recurring task rolls forward and stays open");
    assert!(t.due_date.as_deref() > Some("2026-01-05"));

    // Subtasks: make one a subtask of another, then a task of its own.
    let sub = new_task_id();
    core.create_task_with(
        ws.clone(),
        NewTaskInput {
            id: Some(sub.clone()),
            title: "Step".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let s = core
        .update_task(
            sub.clone(),
            TaskChanges {
                parent_id: Some(id.clone()),
                ..ch()
            },
        )
        .unwrap();
    assert_eq!(s.parent_id.as_deref(), Some(id.as_str()));
    let s = core
        .update_task(
            sub.clone(),
            TaskChanges {
                clear_parent: true,
                ..ch()
            },
        )
        .unwrap();
    assert_eq!(s.parent_id, None);

    // The server refuses what the core would not catch (a task as its own subtask).
    assert!(matches!(
        core.update_task(
            id.clone(),
            TaskChanges {
                parent_id: Some(id.clone()),
                ..ch()
            }
        ),
        Err(CoreError::Server { status: 400, .. })
    ));

    // Reminders: add, list, change, remove.
    let r = core
        .add_reminder(id.clone(), ReminderSpec::Before { minutes: 30 })
        .unwrap();
    let r2 = core
        .add_reminder(
            id.clone(),
            ReminderSpec::At {
                at: "2030-01-01T09:00:00.000Z".into(),
            },
        )
        .unwrap();
    assert_eq!(core.task_reminders(id.clone()).unwrap().len(), 2);
    let r = core
        .update_reminder(r.id.clone(), ReminderSpec::Before { minutes: 5 })
        .unwrap();
    assert_eq!(r.spec, ReminderSpec::Before { minutes: 5 });
    core.delete_reminder(r.id).unwrap();
    core.delete_reminder(r2.id).unwrap();
    assert!(core.task_reminders(id.clone()).unwrap().is_empty());

    // Lists and notes.
    assert!(core.teams(ws.clone()).unwrap().is_empty());
    assert_eq!(
        core.tags(ws.clone())
            .unwrap()
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["waiting"]
    );
    assert_eq!(core.task_notes(id.clone()).unwrap(), "");
    assert_eq!(members[0].id, me.id);
}

/// A rule with only a frequency (every 1 unit).
fn first_rule(freq: &str) -> TaskRecurrence {
    TaskRecurrence {
        freq: freq.into(),
        interval: Some(1),
        by_weekday: None,
        by_month_day: None,
        by_nth_weekday: None,
        until: None,
        count: None,
        basis: None,
    }
}

/// Search for text written into a page (after the server's debounced save), then a comment
/// thread's round trip, against the real server (docs/rewrite/status/core.md, "For apple:
/// search" and "For apple: comments").
#[test]
fn search_and_comments_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let core = Core::new(url);
    let me = core
        .register(
            "Search Test".into(),
            format!("search-test-{stamp}@example.com"),
            "correct horse battery staple 1".into(),
        )
        .unwrap()
        .user;
    let ws = core.workspaces().unwrap()[0].id.clone();
    let tree = core.tree(ws.clone()).unwrap();
    let page = &tree.pages[0];

    // Write a word nothing else has into the page's body.
    let ev = Arc::new(LiveEvents::default());
    let live = core.open_live_page(page.id.clone(), ev.clone()).unwrap();
    wait_for("sync", 10, || {
        ev.statuses.lock().unwrap().contains(&LiveStatus::Synced)
    });
    let main = live
        .info()
        .boxes
        .first()
        .map(|b| format!("box:{}", b.id))
        .unwrap_or_else(|| "default".into());
    let word = format!("quokkamarker{stamp}");
    live.apply_update(add_paragraph(
        &live.document(),
        &main,
        &format!("A note about the {word} for the search test"),
    ))
    .unwrap();
    wait_for("the server's receipt", 10, || live.unsent_updates() == 0);

    // The server saves after a pause and indexes then; a prefix of the word finds the page, and
    // its snippet marks the match.
    let prefix = &word[..word.len() - 3];
    let found: Mutex<Option<PageSearchHit>> = Mutex::new(None);
    wait_for("the page to be searchable", 20, || {
        let r = core.search(ws.clone(), prefix.into(), None).unwrap();
        let hit = r.pages.into_iter().find(|p| p.page_id == page.id);
        let some = hit.is_some();
        *found.lock().unwrap() = hit;
        some
    });
    let hit = found.into_inner().unwrap().unwrap();
    assert_eq!(hit.title, page.title);
    assert!(
        hit.path.contains(&hit.notebook_name) && hit.path.contains(&hit.section_name),
        "{}",
        hit.path
    );
    let matched: Vec<&str> = hit
        .snippet
        .iter()
        .filter(|r| r.matched)
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(matched, [word.as_str()], "{:?}", hit.snippet);
    assert!(hit.snippet.iter().any(|r| !r.matched));
    // Nothing else matches; a blank query and a limit are fine.
    assert!(core
        .search(ws.clone(), format!("nomatch{stamp}"), Some(5))
        .unwrap()
        .pages
        .is_empty());

    // A task is found by its title.
    let task = core
        .create_task(ws.clone(), format!("Zebrafinch{stamp} task"), None)
        .unwrap();
    let r = core
        .search(ws.clone(), format!("zebrafinch{stamp}"), None)
        .unwrap();
    assert_eq!(
        r.tasks
            .iter()
            .map(|t| t.task.id.as_str())
            .collect::<Vec<_>>(),
        [task.id.as_str()]
    );

    // Comments: create the thread under a client id, reply, resolve, reopen by replying, edit,
    // delete a comment, then the thread.
    assert!(core.page_comments(page.id.clone()).unwrap().is_empty());
    let tid = new_comment_thread_id();
    let t = core
        .add_comment_thread(
            page.id.clone(),
            tid.clone(),
            "the note".into(),
            "First".into(),
        )
        .unwrap();
    assert_eq!(
        (
            t.id.as_str(),
            t.page_id.as_str(),
            t.quote.as_str(),
            t.resolved
        ),
        (tid.as_str(), page.id.as_str(), "the note", false)
    );
    assert_eq!(t.comments.len(), 1);
    assert_eq!(
        (
            t.comments[0].body.as_str(),
            t.comments[0].author_id.as_str()
        ),
        ("First", me.id.as_str())
    );
    // A retry with the same id returns the same thread.
    let again = core
        .add_comment_thread(
            page.id.clone(),
            tid.clone(),
            "the note".into(),
            "First".into(),
        )
        .unwrap();
    assert_eq!(again.comments.len(), 1);

    let t = core
        .reply_to_comment_thread(tid.clone(), "Second".into())
        .unwrap();
    assert_eq!(t.comments.len(), 2);
    let t = core.resolve_comment_thread(tid.clone()).unwrap();
    assert!(t.resolved && t.resolved_by.as_deref() == Some(me.id.as_str()));
    let t = core.reopen_comment_thread(tid.clone()).unwrap();
    assert!(!t.resolved && t.resolved_at.is_none());
    core.resolve_comment_thread(tid.clone()).unwrap();
    let t = core
        .reply_to_comment_thread(tid.clone(), "Third".into())
        .unwrap();
    assert!(!t.resolved, "a reply reopens a resolved thread");
    let second = t.comments[1].id.clone();
    let t = core
        .edit_comment(second.clone(), "Second, edited".into())
        .unwrap();
    assert_eq!(t.comments[1].body, "Second, edited");
    assert!(t.comments[1].edited_at.is_some());
    let listed = core.page_comments(page.id.clone()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].comments.len(), 3);
    assert!(matches!(
        core.reply_to_comment_thread(tid.clone(), "  ".into()),
        Err(CoreError::Server { status: 400, .. })
    ));
    assert!(!core.delete_comment(second).unwrap());
    assert_eq!(
        core.page_comments(page.id.clone()).unwrap()[0]
            .comments
            .len(),
        2
    );
    core.delete_comment_thread(tid.clone()).unwrap();
    assert!(core.page_comments(page.id.clone()).unwrap().is_empty());
    // The last comment of a thread takes the thread with it.
    let tid2 = new_comment_thread_id();
    let t = core
        .add_comment_thread(page.id.clone(), tid2, String::new(), "Only".into())
        .unwrap();
    assert!(core.delete_comment(t.comments[0].id.clone()).unwrap());
    assert!(core.page_comments(page.id.clone()).unwrap().is_empty());
    live.close();
}

/// The stored tree's pages of one section, in position order, as "id".
fn cached_section_pages(core: &Core, ws: &str, section: &str) -> Vec<String> {
    let mut v: Vec<_> = core
        .cached_tree(ws.into())
        .unwrap()
        .pages
        .into_iter()
        .filter(|p| p.section_id == section)
        .collect();
    v.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap());
    v.into_iter().map(|p| p.id).collect()
}

fn page_title(t: &Tree, id: &str) -> String {
    t.pages.iter().find(|p| p.id == id).unwrap().title.clone()
}

#[test]
fn tree_management_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let db = std::env::temp_dir().join(format!("nv-core-tree-server-{stamp}/store.db"));
    let core = Core::with_store(url.clone(), db.to_string_lossy().into_owned());
    core.register(
        "Tree Test".into(),
        format!("tree-test-{stamp}@example.com"),
        "correct horse battery staple 1".into(),
    )
    .unwrap();
    let ws = core.workspaces().unwrap()[0].id.clone();
    core.tree(ws.clone()).unwrap();
    let cached = || core.cached_tree(ws.clone()).unwrap();

    // A notebook starts with one "General" section; the stored tree has both at once.
    let nb = core
        .create_notebook(ws.clone(), "Projects".into(), Some("#4f46e5".into()), None)
        .unwrap();
    let t = cached();
    let n = t.notebooks.iter().find(|n| n.id == nb.id).unwrap();
    assert_eq!(
        (n.name.as_str(), n.color.as_str(), n.visibility.as_str()),
        ("Projects", "#4f46e5", "shared")
    );
    assert!(t
        .sections
        .iter()
        .any(|s| s.id == nb.section_id && s.name == "General"));
    // A blank name is refused by the server and nothing changes.
    assert!(matches!(
        core.create_notebook(ws.clone(), "  ".into(), None, None),
        Err(CoreError::Server { status: 400, .. })
    ));

    // Notebook: rename, colour, a bad colour.
    core.rename_notebook(nb.id.clone(), "Work".into()).unwrap();
    core.set_notebook_color(nb.id.clone(), "#10b981".into())
        .unwrap();
    assert!(matches!(
        core.set_notebook_color(nb.id.clone(), "green".into()),
        Err(CoreError::Server { status: 400, .. })
    ));
    let n = cached()
        .notebooks
        .into_iter()
        .find(|n| n.id == nb.id)
        .unwrap();
    assert_eq!((n.name.as_str(), n.color.as_str()), ("Work", "#10b981"));

    // A second notebook, then reorder: first, and last again.
    let nb2 = core
        .create_notebook(ws.clone(), "Home".into(), None, None)
        .unwrap();
    let order = |t: &Tree| {
        let mut v: Vec<_> = t.notebooks.iter().collect();
        v.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap());
        v.into_iter().map(|n| n.id.clone()).collect::<Vec<_>>()
    };
    assert_eq!(*order(&cached()).last().unwrap(), nb2.id);
    let pos = core.move_notebook(nb2.id.clone(), Some(0)).unwrap();
    assert_eq!(order(&cached())[0], nb2.id);
    assert_eq!(
        cached()
            .notebooks
            .iter()
            .find(|n| n.id == nb2.id)
            .unwrap()
            .position,
        pos
    );
    core.move_notebook(nb2.id.clone(), None).unwrap();
    assert_eq!(*order(&cached()).last().unwrap(), nb2.id);

    // Sections: a second section, a subsection, a sub-subsection, and the 3-level limit.
    let a = nb.section_id.clone();
    let b = core
        .create_section(nb.id.clone(), "Plans".into(), None, Some("#ef4444".into()))
        .unwrap();
    let sub = core
        .create_section(nb.id.clone(), "Q4".into(), Some(b.clone()), None)
        .unwrap();
    let subsub = core
        .create_section(nb.id.clone(), "Oct".into(), Some(sub.clone()), None)
        .unwrap();
    assert!(matches!(
        core.create_section(nb.id.clone(), "Too deep".into(), Some(subsub.clone()), None),
        Err(CoreError::Server { status: 400, .. })
    ));
    let t = cached();
    let s = |id: &str| t.sections.iter().find(|s| s.id == id).unwrap().clone();
    assert_eq!(s(&sub).parent_id.as_deref(), Some(b.as_str()));
    assert_eq!(s(&subsub).parent_id.as_deref(), Some(sub.as_str()));
    assert_eq!(s(&b).color, "#ef4444");
    core.rename_section(b.clone(), "Roadmap".into()).unwrap();
    core.set_section_color(b.clone(), "#0ea5e9".into()).unwrap();
    let t = cached();
    let sb = t.sections.iter().find(|s| s.id == b).unwrap();
    assert_eq!(
        (sb.name.as_str(), sb.color.as_str()),
        ("Roadmap", "#0ea5e9")
    );

    // Move a section: Q4 (with Oct) up to the top level at the front, then into the other
    // notebook, then back under Roadmap; moving it into its own child is refused.
    let m = core
        .move_section(sub.clone(), nb.id.clone(), None, Some(0))
        .unwrap();
    assert_eq!(
        (m.notebook_id.as_str(), m.parent_id.clone()),
        (nb.id.as_str(), None)
    );
    let t = cached();
    assert_eq!(
        t.sections.iter().find(|s| s.id == sub).unwrap().parent_id,
        None
    );
    let top = |t: &Tree, nbid: &str| {
        let mut v: Vec<_> = t
            .sections
            .iter()
            .filter(|s| s.notebook_id == nbid && s.parent_id.is_none())
            .collect();
        v.sort_by(|a, b| a.position.partial_cmp(&b.position).unwrap());
        v.into_iter().map(|s| s.id.clone()).collect::<Vec<_>>()
    };
    assert_eq!(top(&t, &nb.id)[0], sub, "dropped first");
    assert!(matches!(
        core.move_section(sub.clone(), nb.id.clone(), Some(subsub.clone()), None),
        Err(CoreError::Server { status: 400, .. })
    ));
    let m = core
        .move_section(sub.clone(), nb2.id.clone(), None, None)
        .unwrap();
    assert_eq!(m.notebook_id, nb2.id);
    let t = cached();
    assert_eq!(
        t.sections.iter().find(|s| s.id == sub).unwrap().notebook_id,
        nb2.id
    );
    assert_eq!(
        t.sections
            .iter()
            .find(|s| s.id == subsub)
            .unwrap()
            .notebook_id,
        nb2.id,
        "its subsections go with it"
    );
    let m = core
        .move_section(sub.clone(), nb.id.clone(), Some(b.clone()), None)
        .unwrap();
    assert_eq!(
        (m.notebook_id.as_str(), m.parent_id.as_deref()),
        (nb.id.as_str(), Some(b.as_str()))
    );
    assert_eq!(
        cached()
            .sections
            .iter()
            .find(|s| s.id == subsub)
            .unwrap()
            .notebook_id,
        nb.id
    );

    // Pages: create, rename, icon; reorder inside a section; move to another section.
    let p1 = core.create_page(a.clone(), Some("One".into())).unwrap();
    let p2 = core.create_page(a.clone(), Some("Two".into())).unwrap();
    let p3 = core.create_page(a.clone(), None).unwrap();
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p1.clone(), p2.clone(), p3.clone()]
    );
    core.rename_page(p3.clone(), "Three".into()).unwrap();
    core.set_page_icon(p3.clone(), Some("*".into())).unwrap();
    let t = cached();
    let pm = t.pages.iter().find(|p| p.id == p3).unwrap();
    assert_eq!(
        (pm.title.as_str(), pm.icon.as_deref()),
        ("Three", Some("*"))
    );
    core.set_page_icon(p3.clone(), None).unwrap();
    assert_eq!(
        cached().pages.iter().find(|p| p.id == p3).unwrap().icon,
        None
    );
    // p3 to the front; then p1 to index 2 (among the others, without itself: the end).
    core.move_page(p3.clone(), None, Some(0)).unwrap();
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p3.clone(), p1.clone(), p2.clone()]
    );
    core.move_page(p1.clone(), None, Some(2)).unwrap();
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p3.clone(), p2.clone(), p1.clone()]
    );
    // The position the web would compute for the same drop is the one the server chooses.
    let sibs: Vec<f64> = {
        let t = cached();
        let mut v: Vec<_> = t
            .pages
            .iter()
            .filter(|p| p.section_id == a && p.id != p2)
            .collect();
        v.sort_by(|x, y| x.position.partial_cmp(&y.position).unwrap());
        v.iter().map(|p| p.position).collect()
    };
    let want = position_at(sibs, 1);
    let place = core.move_page(p2.clone(), None, Some(1)).unwrap();
    assert_eq!(place.position, want);
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p3.clone(), p2.clone(), p1.clone()]
    );
    // To another section (a subsection), at the end; then back to the front of the first.
    let place = core.move_page(p1.clone(), Some(sub.clone()), None).unwrap();
    assert_eq!(place.section_id, sub);
    assert_eq!(cached_section_pages(&core, &ws, &sub), vec![p1.clone()]);
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p3.clone(), p2.clone()]
    );
    core.move_page(p1.clone(), Some(a.clone()), Some(0))
        .unwrap();
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p1.clone(), p3.clone(), p2.clone()]
    );
    // Another workspace's section is refused.
    let other = Core::new(url.clone());
    other
        .register(
            "Other".into(),
            format!("tree-other-{stamp}@example.com"),
            "correct horse battery staple 1".into(),
        )
        .unwrap();
    let ows = other.workspaces().unwrap()[0].id.clone();
    let osec = other.tree(ows).unwrap().sections[0].id.clone();
    assert!(matches!(
        core.move_page(p1.clone(), Some(osec), None),
        Err(CoreError::Server { .. })
    ));

    // Duplicate a page: next to the original, "(copy)"; into another section keeps the title.
    let c1 = core.copy_page(p1.clone(), None, None).unwrap();
    assert_eq!(
        cached_section_pages(&core, &ws, &a),
        [p1.clone(), c1.clone(), p3.clone(), p2.clone()]
    );
    assert_eq!(page_title(&cached(), &c1), "One (copy)");
    let c2 = core.copy_page(p1.clone(), Some(b.clone()), None).unwrap();
    assert_eq!(page_title(&cached(), &c2), "One");
    // Duplicate a section with its subsections and pages.
    let cs = core.copy_section(b.clone(), None, None).unwrap();
    let t = cached();
    let csec = t.sections.iter().find(|s| s.id == cs).unwrap();
    assert_eq!(csec.name, "Roadmap (copy)");
    assert!(t
        .sections
        .iter()
        .any(|s| s.parent_id.as_deref() == Some(cs.as_str()) && s.name == "Q4"));
    assert!(t.sections.iter().any(|s| s.name == "Oct" && s.id != subsub));

    // Trash: a page, a section with its pages and subsections, a notebook.
    let tr = core.delete_page(p2.clone()).unwrap();
    assert_eq!(tr.trash_id, p2);
    let t = cached();
    assert!(!t.pages.iter().any(|p| p.id == p2));
    assert!(core
        .cached_trashed_pages(ws.clone())
        .unwrap()
        .iter()
        .any(|p| p.id == p2));
    let items = core.trash(ws.clone()).unwrap();
    assert_eq!(items[0].kind, TrashKind::Page);
    assert_eq!(items[0].id, p2);
    assert_eq!(items[0].name, "Two");
    assert_eq!(items[0].days_left, 60);
    // Restore: back where it was.
    assert_eq!(
        core.restore_from_trash(ws.clone(), TrashKind::Page, p2.clone())
            .unwrap(),
        None
    );
    assert!(cached().pages.iter().any(|p| p.id == p2));
    assert!(core.cached_trashed_pages(ws.clone()).unwrap().is_empty());
    // A section with a subsection and a page goes as one entry and comes back as one.
    core.delete_section(b.clone()).unwrap();
    let t = cached();
    assert!(!t
        .sections
        .iter()
        .any(|s| s.id == b || s.id == sub || s.id == subsub));
    let items = core.trash(ws.clone()).unwrap();
    let it = items.iter().find(|i| i.id == b).unwrap();
    assert_eq!(it.kind, TrashKind::Section);
    assert!(it.sections >= 2 && it.pages >= 1, "{it:?}");
    core.restore_from_trash(ws.clone(), TrashKind::Section, b.clone())
        .unwrap();
    assert!(cached().sections.iter().any(|s| s.id == sub));
    // Delete forever: the copy of the section made above.
    core.delete_section(cs.clone()).unwrap();
    core.delete_forever(ws.clone(), TrashKind::Section, cs.clone())
        .unwrap();
    assert!(!core.trash(ws.clone()).unwrap().iter().any(|i| i.id == cs));
    assert!(matches!(
        core.restore_from_trash(ws.clone(), TrashKind::Section, cs.clone()),
        Err(CoreError::Server { status: 404, .. })
    ));
    // A notebook: delete, restore, delete, then empty the Trash.
    core.delete_notebook(nb2.id.clone()).unwrap();
    assert!(!cached().notebooks.iter().any(|n| n.id == nb2.id));
    core.restore_from_trash(ws.clone(), TrashKind::Notebook, nb2.id.clone())
        .unwrap();
    assert!(cached().notebooks.iter().any(|n| n.id == nb2.id));
    core.delete_notebook(nb2.id.clone()).unwrap();
    core.delete_page(p3.clone()).unwrap();
    let removed = core.empty_trash(ws.clone()).unwrap();
    assert_eq!(removed, 2);
    assert!(core.trash(ws.clone()).unwrap().is_empty());
    assert!(core.cached_trashed_pages(ws.clone()).unwrap().is_empty());
    assert!(matches!(
        core.restore_from_trash(ws.clone(), TrashKind::Notebook, nb2.id.clone()),
        Err(CoreError::Server { status: 404, .. })
    ));

    // The stored tree is what the server has.
    let server_tree = core.tree(ws.clone()).unwrap();
    assert_eq!(server_tree, cached());
    let _ = std::fs::remove_dir_all(db.parent().unwrap());
}

// ───────── Sharing, version history and locked pages ─────────

/// Every byte of a store on disk: the database, its write-ahead log and shared memory.
fn disk_bytes(db: &std::path::Path) -> Vec<u8> {
    let mut all = Vec::new();
    for ext in ["", "-wal", "-shm"] {
        if let Ok(b) = std::fs::read(format!("{}{ext}", db.display())) {
            all.extend(b);
        }
    }
    assert!(all.len() > 1000, "no store file at {}", db.display());
    all
}

fn on_disk(db: &std::path::Path, needle: &str) -> bool {
    let all = disk_bytes(db);
    all.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn server_status(e: CoreError) -> (u16, Option<String>) {
    match e {
        CoreError::Server { status, code, .. } => (status, code),
        e => panic!("not a server refusal: {e:?}"),
    }
}

fn open_live(core: &Core, page: &str) -> (Arc<LivePage>, Arc<LiveEvents>) {
    let ev = Arc::new(LiveEvents::default());
    let live = core.open_live_page(page.into(), ev.clone()).unwrap();
    wait_for("the page to sync", 10, || {
        ev.statuses.lock().unwrap().contains(&LiveStatus::Synced)
    });
    (live, ev)
}

fn type_in(live: &LivePage, text: &str) {
    live.apply_update(add_paragraph(&live.document(), "box:main", text))
        .unwrap();
}

fn short_id(url_or_token: &str) -> String {
    url_or_token.rsplit('/').next().unwrap().to_string()
}

#[test]
fn sharing_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = std::env::temp_dir().join(format!("nv-core-share-server-{stamp}"));
    let pw = "correct horse battery staple 1";
    let (ea, eb, ec) = (
        format!("share-a-{stamp}@example.com"),
        format!("share-b-{stamp}@example.com"),
        format!("share-c-{stamp}@example.com"),
    );
    let a = Core::with_store(url.clone(), dir.join("a.db").to_string_lossy().into_owned());
    let b = Core::with_store(url.clone(), dir.join("b.db").to_string_lossy().into_owned());
    let ua = a
        .register("Share A".into(), ea.clone(), pw.into())
        .unwrap()
        .user;
    let ub = b
        .register("Share B".into(), eb.clone(), pw.into())
        .unwrap()
        .user;
    let wa = a.workspaces().unwrap()[0].id.clone();
    b.workspaces().unwrap();

    // Members: A alone, no invites.
    let p = a.workspace_people(wa.clone()).unwrap();
    assert_eq!((p.members.len(), p.invites.len()), (1, 0));
    assert_eq!(p.members[0].role, "owner");

    // B has an account: added at once, as a viewer. The test server sends no mail.
    let r = a
        .invite_member(wa.clone(), eb.clone(), Some("viewer".into()))
        .unwrap();
    assert_eq!(
        (r.status.as_str(), r.emailed, r.invite_url),
        ("added", false, None)
    );
    assert_eq!(
        server_status(a.invite_member(wa.clone(), eb.clone(), None).unwrap_err()).0,
        409,
        "already a member"
    );
    assert!(b
        .workspaces()
        .unwrap()
        .iter()
        .any(|w| w.id == wa && w.role == "viewer"));
    // What a viewer may and may not do.
    let seen_by_b = b.workspace_people(wa.clone()).unwrap();
    assert_eq!((seen_by_b.members.len(), seen_by_b.invites.len()), (2, 0));
    let refusals = [
        b.invite_member(wa.clone(), format!("x-{stamp}@example.com"), None)
            .map(|_| ()),
        b.set_member_role(wa.clone(), ub.id.clone(), "owner".into()),
        b.remove_member(wa.clone(), ua.id.clone()),
        b.revoke_invite(wa.clone(), "nobody@example.com".into()),
    ];
    for refused in refusals {
        assert_eq!(server_status(refused.unwrap_err()).0, 403);
    }

    // An address with no account: an invite link, readable before it is accepted.
    let r = a
        .invite_member(wa.clone(), ec.clone(), Some("member".into()))
        .unwrap();
    assert_eq!((r.status.as_str(), r.emailed), ("invited", false));
    let link = r.invite_url.expect("with no mail, the link is returned");
    let token = short_id(&link);
    let info = a.invite_info(token.clone()).unwrap();
    assert_eq!(
        (info.email.as_str(), info.role.as_str(), info.expired),
        (ec.as_str(), "member", false)
    );
    assert_eq!(info.workspace_id, wa);
    assert_eq!(a.workspace_people(wa.clone()).unwrap().invites[0].email, ec);
    // Someone else cannot use it.
    assert_eq!(
        server_status(b.accept_invite(token.clone()).unwrap_err()).0,
        403
    );
    // Resend: a fresh link; the old one stops working.
    let r2 = a.resend_invite(wa.clone(), ec.clone()).unwrap();
    let token2 = short_id(&r2.invite_url.unwrap());
    assert_ne!(token, token2);
    assert_eq!(server_status(a.invite_info(token).unwrap_err()).0, 404);
    // Revoke it.
    a.revoke_invite(wa.clone(), ec.clone()).unwrap();
    assert!(a.workspace_people(wa.clone()).unwrap().invites.is_empty());
    assert_eq!(server_status(a.invite_info(token2).unwrap_err()).0, 404);
    // An invited address that then signs up joins on sign-up (accounts are confirmed at once
    // here, so the server applies the pending invite itself).
    a.invite_member(wa.clone(), ec.clone(), None).unwrap();
    let c = Core::new(url.clone());
    let uc = c
        .register("Share C".into(), ec.clone(), pw.into())
        .unwrap()
        .user;
    assert!(c
        .workspaces()
        .unwrap()
        .iter()
        .any(|w| w.id == wa && w.role == "member"));
    assert!(a.workspace_people(wa.clone()).unwrap().invites.is_empty());

    // Roles: the owner promotes B; an admin cannot make an owner; the last owner cannot go.
    a.set_member_role(wa.clone(), ub.id.clone(), "admin".into())
        .unwrap();
    assert!(b
        .workspaces()
        .unwrap()
        .iter()
        .any(|w| w.id == wa && w.role == "admin"));
    assert_eq!(
        server_status(
            b.set_member_role(wa.clone(), ub.id.clone(), "owner".into())
                .unwrap_err()
        )
        .0,
        403
    );
    assert_eq!(
        server_status(
            a.set_member_role(wa.clone(), ua.id.clone(), "member".into())
                .unwrap_err()
        )
        .0,
        400,
        "a workspace needs an owner"
    );
    assert_eq!(
        server_status(a.leave_workspace(wa.clone()).unwrap_err()).0,
        400
    );
    // An admin removes members, but not an owner.
    assert_eq!(
        server_status(b.remove_member(wa.clone(), ua.id.clone()).unwrap_err()).0,
        403
    );
    b.remove_member(wa.clone(), uc.id.clone()).unwrap();
    assert!(c.workspaces().unwrap().iter().all(|w| w.id != wa));
    // B leaves: the workspace goes from B's stored list and tree.
    b.tree(wa.clone()).unwrap();
    assert!(b.cached_tree(wa.clone()).is_some());
    b.leave_workspace(wa.clone()).unwrap();
    assert!(b.cached_workspaces().unwrap().iter().all(|w| w.id != wa));
    assert!(b.cached_tree(wa.clone()).is_none());
    assert_eq!(a.workspace_people(wa.clone()).unwrap().members.len(), 1);

    // B back in as a member, to share things with.
    a.invite_member(wa.clone(), eb.clone(), Some("member".into()))
        .unwrap();
    assert!(b
        .workspaces()
        .unwrap()
        .iter()
        .any(|w| w.id == wa && w.role == "member"));

    // A private notebook shared with B, then not.
    let ta = a.tree(wa.clone()).unwrap();
    let nb = a
        .create_notebook(wa.clone(), "Private".into(), None, Some("private".into()))
        .unwrap();
    assert!(!b
        .tree(wa.clone())
        .unwrap()
        .notebooks
        .iter()
        .any(|n| n.id == nb.id));
    let sh = a.notebook_shares(nb.id.clone()).unwrap();
    assert_eq!(
        (
            sh.visibility.as_str(),
            sh.created_by.as_str(),
            sh.user_ids.len()
        ),
        ("private", ua.id.as_str(), 0)
    );
    assert_eq!(
        a.set_notebook_shares(nb.id.clone(), vec![ub.id.clone()])
            .unwrap(),
        std::slice::from_ref(&ub.id)
    );
    assert!(b
        .tree(wa.clone())
        .unwrap()
        .notebooks
        .iter()
        .any(|n| n.id == nb.id));
    assert_eq!(
        server_status(b.set_notebook_shares(nb.id.clone(), vec![]).unwrap_err()).0,
        403,
        "only the creator"
    );
    assert_eq!(
        server_status(
            a.set_notebook_shares(nb.id.clone(), vec!["nobody".into()])
                .unwrap_err()
        )
        .0,
        400
    );
    a.set_notebook_shares(nb.id.clone(), vec![]).unwrap();
    assert!(!b
        .tree(wa.clone())
        .unwrap()
        .notebooks
        .iter()
        .any(|n| n.id == nb.id));

    // A page in a shared notebook: shared with B (a member), changed, shared by email with
    // someone outside (owners and admins only), revoked, and removed by B itself.
    let page = ta.pages[0].id.clone();
    let r = a
        .share_page_with_member(page.clone(), ub.id.clone(), false)
        .unwrap();
    assert_eq!(r.status, "shared");
    assert!(r
        .shares
        .shares
        .iter()
        .any(|s| s.user_id == ub.id && !s.can_edit && s.member));
    assert!(b
        .shared_pages()
        .unwrap()
        .iter()
        .any(|p| p.id == page && p.member && !p.can_edit));
    let l = a
        .set_page_share_edit(page.clone(), ub.id.clone(), true)
        .unwrap();
    assert!(l.shares.iter().any(|s| s.user_id == ub.id && s.can_edit));
    let outside = format!("outside-{stamp}@example.com");
    let r = a
        .share_page_by_email(page.clone(), outside.clone(), true)
        .unwrap();
    assert_eq!((r.status.as_str(), r.emailed), ("invited", false));
    assert!(r.invite_url.unwrap().contains("/invite/"));
    assert_eq!(r.shares.invites[0].email, outside);
    assert_eq!(
        server_status(
            b.share_page_by_email(page.clone(), format!("o2-{stamp}@example.com"), false)
                .unwrap_err()
        )
        .0,
        403,
        "a member who is not an admin may not share outside the workspace"
    );
    let l = a.revoke_page_invite(page.clone(), outside).unwrap();
    assert!(l.invites.is_empty());
    let l = b.remove_page_share(page.clone(), ub.id.clone()).unwrap();
    assert!(l.shares.iter().all(|s| s.user_id != ub.id));
    assert!(!b.shared_pages().unwrap().iter().any(|p| p.id == page));
    assert!(a.page_shares(page).unwrap().shares.is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn version_history_and_restore_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = std::env::temp_dir().join(format!("nv-core-ver-server-{stamp}"));
    let pw = "correct horse battery staple 1";
    let (ea, eb) = (
        format!("ver-a-{stamp}@example.com"),
        format!("ver-b-{stamp}@example.com"),
    );
    let a = Core::with_store(url.clone(), dir.join("a.db").to_string_lossy().into_owned());
    let b = Core::with_store(url.clone(), dir.join("b.db").to_string_lossy().into_owned());
    a.register("Ver A".into(), ea.clone(), pw.into()).unwrap();
    b.register("Ver B".into(), eb.clone(), pw.into()).unwrap();
    let wa = a.workspaces().unwrap()[0].id.clone();
    a.invite_member(wa.clone(), eb, Some("member".into()))
        .unwrap();
    b.workspaces().unwrap();

    let t = a.tree(wa.clone()).unwrap();
    let page = a
        .create_page(t.sections[0].id.clone(), Some("History".into()))
        .unwrap();
    b.tree(wa.clone()).unwrap();
    // A separate client takes snapshots the way the web's history dialog does (the Core has no
    // "save a version" call: the server saves versions by itself every few minutes of editing).
    let snap = nv_api::Client::new(&url);
    snap.login(&ea, pw).unwrap();

    let (la, _ea) = open_live(&a, &page);
    let (lb, _eb) = open_live(&b, &page);
    la.create_box_with_id("main".into(), 0.0, 0.0, 600.0, 1.0)
        .unwrap();
    type_in(&la, "FIRST version text");
    let text = |l: &LivePage| l.info().text;
    wait_for("B to have it", 10, || {
        text(&lb).contains("FIRST version text")
    });
    wait_for("receipt", 10, || la.unsent_updates() == 0);
    let v1 = snap.snapshot_page(&page, "manual").unwrap().unwrap();

    // More edits by both.
    type_in(&la, "SECOND text by A");
    type_in(&lb, "THIRD text by B");
    wait_for("both to have all", 10, || {
        text(&la).contains("THIRD") && text(&lb).contains("SECOND")
    });
    wait_for("receipts", 10, || {
        la.unsent_updates() == 0 && lb.unsent_updates() == 0
    });
    let v2 = snap.snapshot_page(&page, "manual").unwrap().unwrap();
    assert_ne!(v1, v2);

    // The list, newest first, and a preview of the first version.
    let list = a.page_versions(page.clone()).unwrap();
    assert_eq!(list[0].id, v2);
    assert!(list.iter().any(|v| v.id == v1 && v.reason == "manual"));
    let prev = a.page_version(page.clone(), v1.clone()).unwrap();
    let info = read_page(prev.document.clone()).unwrap();
    assert!(info.text.contains("FIRST") && !info.text.contains("SECOND"));
    assert!(!page_content(prev.document).unwrap().is_empty());

    // Restore the first version into A's open page. An old copy of the page is kept to merge in later.
    let stale = la.document();
    let before = a
        .restore_version(la.clone(), v1.clone())
        .unwrap()
        .expect("a 'before restore' version");
    let only_first = |t: &str| t.contains("FIRST") && !t.contains("SECOND") && !t.contains("THIRD");
    assert!(only_first(&text(&la)), "{}", text(&la));
    // The other open copy converges on its own, and so does the server's saved page.
    wait_for("B to converge", 10, || only_first(&text(&lb)));
    wait_for("receipt", 10, || la.unsent_updates() == 0);
    let server_text = || {
        read_page(a.page_document(page.clone()).unwrap())
            .unwrap()
            .text
    };
    wait_for("the server's copy", 10, || only_first(&server_text()));
    // Nothing changed since the second snapshot, so the server did not make a new one: the
    // "before restore" version is that one, and it has what was replaced.
    assert_eq!(before, v2);
    let kept = a.page_version(page.clone(), before.clone()).unwrap();
    assert!(read_page(kept.document).unwrap().text.contains("THIRD"));

    // An old copy merged into the open pages brings nothing back.
    la.apply_update(stale.clone()).unwrap();
    lb.apply_update(stale).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    for l in [&la, &lb] {
        assert!(only_first(&text(l)), "{}", text(l));
    }
    wait_for("receipts", 10, || {
        la.unsent_updates() == 0 && lb.unsent_updates() == 0
    });
    assert!(only_first(&server_text()));

    // Typing goes on from the restored page; and the restore itself is undone by restoring the
    // 'before restore' version.
    type_in(&lb, "AFTER restore by B");
    wait_for("A to see it", 10, || {
        text(&la).contains("AFTER restore by B")
    });
    // This time the page has changed since the last snapshot: a new "before restore" version.
    let undo_point = a.restore_version(la.clone(), before).unwrap().unwrap();
    assert_ne!(undo_point, v2);
    let list = a.page_versions(page.clone()).unwrap();
    assert!(list
        .iter()
        .any(|v| v.id == undo_point && v.reason == "restore"));
    wait_for("B to see the undo", 10, || {
        let t = text(&lb);
        t.contains("SECOND") && t.contains("THIRD") && !t.contains("AFTER")
    });
    wait_for("the server", 10, || {
        let t = server_text();
        t.contains("THIRD") && !t.contains("AFTER")
    });
    wait_for("receipts", 10, || {
        la.unsent_updates() == 0 && lb.unsent_updates() == 0
    });
    la.close();
    lb.close();
    assert!(a.unsent_pages().is_empty() && b.unsent_pages().is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn locked_pages_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dir = std::env::temp_dir().join(format!("nv-core-lock-server-{stamp}"));
    let db = dir.join("a.db");
    let pw = "correct horse battery staple 1";
    let lock_pw = "vault-pass-4471";
    let new_lock_pw = "vault-pass-9082";
    let a = Core::with_store(url.clone(), db.to_string_lossy().into_owned());
    a.register(
        "Lock A".into(),
        format!("lock-a-{stamp}@example.com"),
        pw.into(),
    )
    .unwrap();
    let wa = a.workspaces().unwrap()[0].id.clone();
    a.tree(wa.clone()).unwrap();

    // A private notebook with a page, some text and a task on it.
    let nb = a
        .create_notebook(wa.clone(), "Vault".into(), None, Some("private".into()))
        .unwrap();
    let page = a
        .create_page(nb.section_id.clone(), Some("Vault page".into()))
        .unwrap();
    let (live, _ev) = open_live(&a, &page);
    live.create_box_with_id("main".into(), 0.0, 0.0, 600.0, 1.0)
        .unwrap();
    type_in(&live, "VAULTBODY-one");
    let task = a
        .create_task_with(
            wa.clone(),
            NewTaskInput {
                id: Some(new_task_id()),
                title: "VAULTTASK-title".into(),
                page_id: Some(page.clone()),
                description: Some("VAULTDESC-text".into()),
                ..Default::default()
            },
        )
        .unwrap();
    // The task is on the page once the page's document refers to it (the server reads it there).
    {
        let doc = nv_model::doc_from_update(&live.document()).unwrap();
        let before = doc.transact().state_vector();
        {
            let mut txn = doc.transact_mut();
            let frag = txn.get_or_insert_xml_fragment("box:main");
            let len = frag.len(&txn);
            let r = frag.insert(&mut txn, len, XmlElementPrelim::empty("taskRef"));
            r.insert_attribute(&mut txn, "taskId", task.id.as_str());
        }
        live.apply_update(doc.transact().encode_state_as_update_v1(&before))
            .unwrap();
    }
    wait_for("receipt", 10, || live.unsent_updates() == 0);
    wait_for("the task to be on the page", 10, || {
        a.tasks(wa.clone())
            .unwrap()
            .iter()
            .any(|t| t.id == task.id && t.page_id.as_deref() == Some(page.as_str()))
    });
    live.close();
    a.page_document(page.clone()).unwrap();
    assert!(
        a.cached_page_document(page.clone()).is_some(),
        "stored while the page is ordinary"
    );

    // No locked-notes password yet.
    let st = a.locked_notes_status().unwrap();
    assert_eq!(
        (st.has_password, st.unlocked, st.locked_pages),
        (false, false, 0)
    );
    assert_eq!(
        server_status(a.lock_page(page.clone()).unwrap_err()),
        (409, Some("no_lock_password".into()))
    );
    assert_eq!(
        server_status(a.unlock_locked_notes(lock_pw.into()).unwrap_err()).0,
        409
    );
    assert_eq!(
        server_status(
            a.set_locked_notes_password("short".into(), None)
                .unwrap_err()
        )
        .0,
        400
    );
    // Setting it unlocks this sign-in.
    assert!(a
        .set_locked_notes_password(lock_pw.into(), None)
        .unwrap()
        .is_some());
    let st = a.locked_notes_status().unwrap();
    assert_eq!(
        (st.has_password, st.unlocked, st.idle_ms),
        (true, true, 300_000)
    );
    // Changing it needs the current one.
    assert_eq!(
        server_status(
            a.set_locked_notes_password("another-pass-1".into(), None)
                .unwrap_err()
        )
        .0,
        400
    );

    // Lock the page: its stored document goes, and its stored task is withheld, though the
    // sign-in is unlocked and the server still sends the task in full.
    a.lock_page(page.clone()).unwrap();
    assert!(a
        .cached_tree(wa.clone())
        .unwrap()
        .pages
        .iter()
        .any(|p| p.id == page && p.locked));
    assert!(a.cached_page_document(page.clone()).is_none());
    let full = a.tasks(wa.clone()).unwrap();
    let t = full.iter().find(|x| x.id == task.id).unwrap();
    assert_eq!(
        (t.title.as_str(), t.locked),
        ("VAULTTASK-title", false),
        "unlocked: in full"
    );
    let stored = a.cached_tasks(wa.clone()).unwrap();
    let t = stored.iter().find(|x| x.id == task.id).unwrap();
    assert_eq!(
        (t.title.as_str(), t.description.as_str(), t.locked),
        ("Locked task", "", true)
    );
    // Readable while unlocked, and never stored.
    let doc = a.page_document(page.clone()).unwrap();
    assert!(read_page(doc).unwrap().text.contains("VAULTBODY-one"));
    assert!(a.cached_page_document(page.clone()).is_none());
    a.page_versions(page.clone()).unwrap();

    // Live editing while unlocked: in memory only.
    let (live, _ev) = open_live(&a, &page);
    assert!(live.info().text.contains("VAULTBODY-one"));
    type_in(&live, "VAULTTYPED-two");
    wait_for("receipt", 10, || live.unsent_updates() == 0);
    assert!(a.unsent_pages().is_empty());
    live.close();
    assert_eq!(a.store_error(), None);

    // Lock now: the content is withheld again, tasks are the server's "Locked task", and an
    // open page ends with NoAccess.
    let (_live, ev2) = open_live(&a, &page);
    a.lock_locked_notes().unwrap();
    assert!(!a.locked_notes_status().unwrap().unlocked);
    wait_for("the page to end", 10, || {
        matches!(
            ev2.statuses.lock().unwrap().last(),
            Some(LiveStatus::Ended {
                reason: LiveEnd::NoAccess,
                ..
            })
        )
    });
    // The server answers as if the page were not there (404), for the document and the history.
    assert_eq!(
        server_status(a.page_document(page.clone()).unwrap_err()).0,
        404
    );
    assert_eq!(
        server_status(a.page_versions(page.clone()).unwrap_err()).0,
        404
    );
    let t = a
        .tasks(wa.clone())
        .unwrap()
        .into_iter()
        .find(|x| x.id == task.id)
        .unwrap();
    assert_eq!((t.title.as_str(), t.locked), ("Locked task", true));
    assert!(!a.keep_locked_notes_unlocked().unwrap().unlocked);

    // Unlock: wrong password (with the tries left), right password. (The refused change of the
    // password above, without the current one, already counted as one wrong try.)
    let tries_before = a.locked_notes_status().unwrap().failures;
    match a
        .unlock_locked_notes("not-the-password".into())
        .unwrap_err()
    {
        CoreError::Server {
            status,
            code,
            message,
        } => {
            assert_eq!((status, code.as_deref()), (400, Some("wrong_password")));
            assert!(message.contains("tries left"), "{message}");
            assert!(!message.contains("not-the-password"));
        }
        e => panic!("{e:?}"),
    }
    assert_eq!(a.locked_notes_status().unwrap().failures, tries_before + 1);
    a.unlock_locked_notes(lock_pw.into()).unwrap();
    let st = a.locked_notes_status().unwrap();
    assert_eq!(
        (st.unlocked, st.failures, st.tries_before_lockout),
        (true, 0, 5)
    );
    assert!(a.keep_locked_notes_unlocked().unwrap().unlocked);
    let t = a
        .tasks(wa.clone())
        .unwrap()
        .into_iter()
        .find(|x| x.id == task.id)
        .unwrap();
    assert_eq!(t.title, "VAULTTASK-title");

    // Face ID: set up while unlocked, lock, unlock with the secret; a wrong install is refused.
    let install = "install-id-0123456789abcdef".to_string();
    let dev = a
        .register_unlock_device(install.clone(), Some("Test phone".into()))
        .unwrap();
    let dev_secret = dev.secret.clone();
    assert!(a
        .locked_notes_status()
        .unwrap()
        .devices
        .iter()
        .any(|d| d.id == dev.id));
    a.lock_locked_notes().unwrap();
    assert_eq!(
        server_status(a.register_unlock_device(install.clone(), None).unwrap_err()),
        (403, Some("locked".into())),
        "needs an unlocked sign-in"
    );
    assert_eq!(
        server_status(
            a.unlock_locked_notes_with_device(
                dev.id.clone(),
                dev.secret.clone(),
                "other-install-0123456789".into()
            )
            .unwrap_err()
        ),
        (401, Some("device_revoked".into()))
    );
    assert_eq!(
        a.locked_notes_status().unwrap().failures,
        1,
        "one refusal counted once: a 401 here is not retried after a refresh"
    );
    a.unlock_locked_notes_with_device(dev.id.clone(), dev.secret.clone(), install.clone())
        .unwrap();
    assert!(a.locked_notes_status().unwrap().unlocked);

    // Changing the password: devices are gone, the old password is not the password any more,
    // this sign-in stays unlocked.
    a.set_locked_notes_password(new_lock_pw.into(), Some(lock_pw.into()))
        .unwrap();
    assert!(a.locked_notes_status().unwrap().devices.is_empty());
    a.lock_locked_notes().unwrap();
    assert_eq!(
        server_status(a.unlock_locked_notes(lock_pw.into()).unwrap_err()).0,
        400
    );
    assert_eq!(
        server_status(
            a.unlock_locked_notes_with_device(dev.id, dev.secret, install)
                .unwrap_err()
        )
        .0,
        401
    );
    a.unlock_locked_notes(new_lock_pw.into()).unwrap();

    // Everything the session did with this page, its tasks and the passwords: not on disk.
    let (live, _e) = open_live(&a, &page);
    type_in(&live, "VAULTTYPED-three");
    wait_for("receipt", 10, || live.unsent_updates() == 0);
    live.close();
    a.tasks(wa.clone()).unwrap();
    assert!(a.cached_page_document(page.clone()).is_none());
    for marker in [
        "VAULTBODY",
        "VAULTTYPED",
        "VAULTTASK",
        "VAULTDESC",
        lock_pw,
        new_lock_pw,
        "not-the-password",
        dev_secret.as_str(),
    ] {
        assert!(!on_disk(&db, marker), "{marker} is on disk");
    }
    assert!(
        on_disk(&db, "Vault page"),
        "the page's title is stored (the owner sees it while locked)"
    );

    // Remove the lock: a wrong password is refused, the right one makes it an ordinary page.
    assert_eq!(
        server_status(
            a.remove_page_lock(page.clone(), "nope-nope-nope".into())
                .unwrap_err()
        )
        .0,
        400
    );
    a.remove_page_lock(page.clone(), new_lock_pw.into())
        .unwrap();
    assert!(!a
        .cached_tree(wa.clone())
        .unwrap()
        .pages
        .iter()
        .any(|p| p.id == page && p.locked));
    assert_eq!(a.locked_notes_status().unwrap().locked_pages, 0);
    a.page_document(page.clone()).unwrap();
    assert!(
        a.cached_page_document(page).is_some(),
        "stored again as an ordinary page"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn ink_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let (email, pw) = (
        format!("ink-{stamp}@example.com"),
        "correct horse battery staple 1",
    );
    let a = Core::new(url.clone());
    a.register("Ink".into(), email.clone(), pw.into()).unwrap();
    let ws = a.workspaces().unwrap()[0].id.clone();
    let t = a.tree(ws).unwrap();
    let page = a
        .create_page(t.sections[0].id.clone(), Some("Ink".into()))
        .unwrap();
    // A second sign-in of the same account.
    let b = Core::new(url.clone());
    b.sign_in(email, pw.into()).unwrap();

    let (la, _ea) = open_live(&a, &page);
    let (lb, _eb) = open_live(&b, &page);
    let samples: Vec<f64> = (0..30)
        .flat_map(|i| {
            [
                20.0 + i as f64 * 6.0,
                60.0 + (i as f64 / 4.0).sin() * 20.0,
                0.4 + i as f64 / 60.0,
                1.2,
                0.5,
                100.0 + i as f64 * 5.0,
            ]
        })
        .collect();
    let drawn = la
        .add_ink_stroke_from_samples(0, 0x1d4ed8ff, 2.5, true, true, samples)
        .unwrap()
        .unwrap();
    wait_for("B to see the stroke", 10, || {
        lb.ink_strokes().iter().any(|s| s.data == drawn.data)
    });
    wait_for("receipt", 10, || la.unsent_updates() == 0);
    // Erase a piece from B; A sees the pieces.
    let r = lb
        .erase_ink(vec![80.0, 30.0, 80.0, 90.0], 6.0, true)
        .unwrap();
    assert_eq!(r.removed, std::slice::from_ref(&drawn.id));
    assert!(!r.added.is_empty());
    wait_for("A to see the cut", 10, || {
        let ids: Vec<String> = la.ink_strokes().into_iter().map(|s| s.id).collect();
        ids.len() == r.added.len() && r.added.iter().all(|i| ids.contains(i))
    });
    wait_for("receipt", 10, || lb.unsent_updates() == 0);
    // The server's saved copy has the pieces (the same blobs), and they read through the core.
    wait_for("the saved copy", 20, || {
        let strokes = read_ink(a.page_document(page.clone()).unwrap()).unwrap();
        strokes.len() == r.added.len() && strokes.iter().all(|s| s.readable)
    });
    let mut theirs: Vec<Vec<u8>> = read_ink(a.page_document(page.clone()).unwrap())
        .unwrap()
        .into_iter()
        .map(|s| s.data)
        .collect();
    let mut mine: Vec<Vec<u8>> = la.ink_strokes().into_iter().map(|s| s.data).collect();
    theirs.sort();
    mine.sort();
    assert_eq!(theirs, mine);
    la.close();
    lb.close();
}
