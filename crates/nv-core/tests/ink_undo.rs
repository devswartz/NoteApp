//! Ink undo/redo on a live page (`LivePage::ink_undo` ...): one step per ink call, only the page's
//! own ink edits are undone (never remote strokes or text), old ids come back after a move, and
//! an undo reaches the server and a second copy like any local edit. Stand-in collab server as in
//! tests/ink.rs.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_core::*;
use nv_model::yrs::{Doc, ReadTxn, StateVector, Transact};
use support::{read_text, type_text, wait_for, TestServer};

#[derive(Clone, Default)]
struct Script(Arc<Mutex<VecDeque<serde_json::Value>>>);
impl nv_api::Transport for Script {
    fn send(&self, req: &nv_api::Request) -> Result<nv_api::Response, String> {
        let body = self
            .0
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| format!("unscripted: {} {}", req.method, req.url))?;
        Ok(nv_api::Response {
            status: 200,
            body: body.to_string(),
            request_id: None,
        })
    }
}

#[derive(Default)]
struct Events {
    synced: Mutex<u32>,
}
impl LivePageListener for Events {
    fn on_status(&self, s: LiveStatus) {
        if s == LiveStatus::Synced {
            *self.synced.lock().unwrap() += 1;
        }
    }
    fn on_change(&self, _: PageInfo) {}
}

fn full(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}

fn open_page(server: &TestServer) -> (Arc<Core>, Arc<LivePage>) {
    let script = Script::default();
    script.0.lock().unwrap().push_back(serde_json::json!({
        "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
        "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true }
    }));
    let core = Core::with_transport(&server.base, Box::new(script), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_live_page("page-1".into(), ev.clone()).unwrap();
    wait_for("sync", || *ev.synced.lock().unwrap() == 1);
    (core, live)
}

fn on_server(server: &TestServer) -> Vec<(String, Vec<u8>)> {
    let doc = nv_model::doc_from_update(&full(server.room.doc())).unwrap();
    nv_model::ink::ink_blobs(&doc)
}

fn blobs(live: &LivePage) -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<_> = live
        .ink_strokes()
        .into_iter()
        .map(|s| (s.id, s.data))
        .collect();
    v.sort();
    v
}

fn ids(live: &LivePage) -> Vec<String> {
    let mut v: Vec<_> = live.ink_strokes().into_iter().map(|s| s.id).collect();
    v.sort();
    v
}

fn sorted_ids(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn line(x0: f64, x1: f64, y: f64) -> Vec<f64> {
    (0..=40)
        .flat_map(|i| {
            let x = x0 + (x1 - x0) * i as f64 / 40.0;
            [
                x,
                y,
                0.5,
                std::f64::consts::FRAC_PI_2,
                0.0,
                5000.0 + i as f64 * 4.0,
            ]
        })
        .collect()
}

fn draw(live: &LivePage, y: f64) -> InkStrokeInfo {
    live.add_ink_stroke_from_samples(0, 0x1f2328ff, 2.5, false, false, line(10.0, 110.0, y))
        .unwrap()
        .unwrap()
}

#[test]
fn add_undo_redo_and_the_flags() {
    let server = TestServer::start(&["acc"]);
    let (_c, a) = open_page(&server);
    assert!(!a.ink_can_undo() && !a.ink_can_redo());
    assert!(!a.ink_undo().unwrap() && !a.ink_redo().unwrap());

    let s1 = draw(&a, 50.0);
    assert!(a.ink_can_undo() && !a.ink_can_redo());
    // Two quick calls are two steps (capture timeout 0).
    let s2 = draw(&a, 150.0);
    assert!(a.ink_undo().unwrap());
    assert_eq!(ids(&a), std::slice::from_ref(&s1.id));
    assert!(a.ink_can_undo() && a.ink_can_redo());
    assert!(a.ink_undo().unwrap());
    assert!(a.ink_strokes().is_empty());
    assert!(!a.ink_can_undo());
    assert!(!a.ink_undo().unwrap());
    assert!(a.ink_redo().unwrap() && a.ink_redo().unwrap());
    assert_eq!(ids(&a), sorted_ids(vec![s1.id.clone(), s2.id.clone()]));
    assert!(!a.ink_can_redo());
    // A new edit drops the redo steps.
    a.ink_undo().unwrap();
    assert!(a.ink_can_redo());
    draw(&a, 250.0);
    assert!(!a.ink_can_redo());
}

#[test]
fn partial_erase_is_one_step_and_undo_restores_the_original() {
    let server = TestServer::start(&["acc"]);
    let (_c, a) = open_page(&server);
    let s1 = draw(&a, 50.0);
    let before = blobs(&a);
    // One gesture across the line, cutting it into pieces.
    let r = a
        .erase_ink(
            vec![40.0, 30.0, 40.0, 70.0, 80.0, 70.0, 80.0, 30.0],
            8.0,
            true,
        )
        .unwrap();
    assert_eq!(r.removed, std::slice::from_ref(&s1.id));
    assert!(r.added.len() >= 2);
    assert!(!ids(&a).contains(&s1.id));
    assert!(a.ink_undo().unwrap());
    assert_eq!(blobs(&a), before);
    assert!(a.ink_redo().unwrap());
    assert_eq!(ids(&a).len(), r.added.len());
    assert!(!ids(&a).contains(&s1.id));
    // The add is still its own step below the erase.
    a.ink_undo().unwrap();
    a.ink_undo().unwrap();
    assert!(a.ink_strokes().is_empty());
}

#[test]
fn move_undo_brings_back_the_old_ids_and_positions() {
    let server = TestServer::start(&["acc"]);
    let (_c, a) = open_page(&server);
    let s1 = draw(&a, 50.0);
    let s2 = draw(&a, 150.0);
    let before = blobs(&a);
    let moved = a
        .move_ink_strokes(vec![s1.id.clone(), s2.id.clone()], 30.0, 20.0)
        .unwrap();
    assert_eq!(moved.len(), 2);
    assert!(!ids(&a).contains(&s1.id));
    assert_ne!(blobs(&a), before);
    assert!(a.ink_undo().unwrap());
    assert_eq!(blobs(&a), before);
    let back = a.ink_strokes();
    assert_eq!(
        back.iter().find(|s| s.id == s1.id).unwrap().points,
        s1.points
    );
    assert!(a.ink_redo().unwrap());
    assert!(!ids(&a).contains(&s1.id) && ids(&a).len() == 2);
}

#[test]
fn delete_undo_and_the_server_and_a_second_copy_follow() {
    let server = TestServer::start(&["acc", "acc"]);
    let (_c1, a) = open_page(&server);
    let (_c2, b) = open_page(&server);
    let s1 = draw(&a, 50.0);
    let s2 = draw(&a, 150.0);
    let both = blobs(&a);
    wait_for("both on B", || blobs(&b) == both);
    assert_eq!(
        a.delete_ink_strokes(vec![s1.id.clone()]).unwrap(),
        std::slice::from_ref(&s1.id)
    );
    wait_for("the delete on the server", || on_server(&server).len() == 1);
    assert!(a.ink_undo().unwrap());
    assert_eq!(blobs(&a), both);
    // The undo is an ordinary local edit: queued, sent, seen by B.
    wait_for("the undo on the server", || on_server(&server) == both);
    wait_for("the undo on B", || blobs(&b) == both);
    assert!(a.ink_redo().unwrap());
    wait_for("the redo on B", || ids(&b) == std::slice::from_ref(&s2.id));
    wait_for("the receipt", || a.unsent_updates() == 0);
}

#[test]
fn remote_strokes_and_text_are_not_undone() {
    let server = TestServer::start(&["acc", "acc"]);
    let (_c1, a) = open_page(&server);
    let (_c2, b) = open_page(&server);
    let mine = draw(&a, 50.0);
    let theirs = draw(&b, 150.0);
    wait_for("both strokes on A", || a.ink_strokes().len() == 2);
    // A text edit made after A's stroke.
    let doc = nv_model::doc_from_update(&a.document()).unwrap();
    let sv = doc.transact().state_vector();
    type_text(&doc, "t", "hello");
    a.apply_update(doc.transact().encode_state_as_update_v1(&sv))
        .unwrap();
    // Undo takes only A's own stroke.
    assert!(a.ink_undo().unwrap());
    assert_eq!(ids(&a), std::slice::from_ref(&theirs.id));
    assert!(!a.ink_can_undo());
    assert!(!a.ink_undo().unwrap());
    assert_eq!(
        read_text(&nv_model::doc_from_update(&a.document()).unwrap(), "t"),
        "hello"
    );
    assert!(a.ink_redo().unwrap());
    assert!(ids(&a).contains(&mine.id) && ids(&a).contains(&theirs.id));
    // B has its own stack: only its own stroke is undoable there.
    wait_for("B has both", || b.ink_strokes().len() == 2);
    assert!(b.ink_can_undo());
    b.ink_undo().unwrap();
    assert_eq!(ids(&b), std::slice::from_ref(&mine.id));
    assert!(!b.ink_undo().unwrap());
}
