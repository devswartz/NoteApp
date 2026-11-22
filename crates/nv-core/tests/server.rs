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
    ReadTxn, Transact, Update, WriteTxn, XmlElementPrelim, XmlFragment, XmlTextPrelim,
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
