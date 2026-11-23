//! Ink calls on a live page (src/ink.rs), against the stand-in collab server
//! (crates/nv-sync/tests/support): add a stroke from a builder and from samples, erase (whole
//! and partial), move, delete, each reaching the server, and two copies of the page converging.
//! A stroke this build can't read (a newer app's) is listed and survives every edit.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_core::*;
use nv_model::yrs::{Any, Doc, Map, ReadTxn, StateVector, Transact, WriteTxn};
use support::{wait_for, TestServer};

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

/// The page's strokes as the server has them: (id, blob) by id.
fn on_server(server: &TestServer) -> Vec<(String, Vec<u8>)> {
    let doc = nv_model::doc_from_update(&full(server.room.doc())).unwrap();
    nv_model::ink::ink_blobs(&doc)
}

fn blobs(live: &LivePage) -> Vec<(String, Vec<u8>)> {
    live.ink_strokes()
        .into_iter()
        .map(|s| (s.id, s.data))
        .collect::<Vec<_>>()
}

fn sorted(mut v: Vec<(String, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    v.sort();
    v
}

/// A pen drawing a line from (x0, y) to (x1, y): 40 samples, 4 ms apart, pressure 0.5.
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

const BLACK: u32 = 0x1f2328ff;
const PEN: u8 = 0;
const HIGHLIGHTER: u8 = 1;

#[test]
fn strokes_are_added_erased_moved_and_deleted_and_two_copies_converge() {
    let server = TestServer::start(&["acc", "acc"]);
    let (_c1, a) = open_page(&server);
    let (_c2, b) = open_page(&server);
    assert!(a.ink_strokes().is_empty());

    // Add from a builder (the pen's live path) and from raw samples.
    let builder = InkStrokeBuilder::new(PEN, BLACK, 2.5, true, false);
    let samples = line(10.0, 110.0, 50.0);
    builder.push_many(samples.clone()).unwrap();
    assert!(builder.point_count() >= 2);
    let preview = builder.preview(vec![120.0, 50.0, 0.5]);
    assert!(!preview.is_empty() && preview[0] == 2.0 || preview[0] == 0.0);
    let s1 = a.add_ink_stroke(builder).unwrap().unwrap();
    assert_eq!(s1.id.len(), 12);
    assert!(s1.readable && s1.tool == PEN && s1.color == BLACK && s1.width == 2.5);
    assert_eq!(s1.z, "a0");
    assert_eq!(s1.flags, 2);
    assert!(s1.created_ms > 1_700_000_000_000);
    assert_eq!(s1.points.len(), s1.point_count as usize * 6);
    let bb = s1.bounds.unwrap();
    assert!(bb.min_x < 10.0 && bb.max_x > 100.0 && bb.min_y < 50.0 && bb.max_y > 50.0);
    // A second pen stroke goes on top of the first; a highlighter has a layer of its own.
    let s2 = a
        .add_ink_stroke_from_samples(PEN, BLACK, 2.5, false, false, line(10.0, 110.0, 150.0))
        .unwrap()
        .unwrap();
    assert_eq!(s2.z, "a1");
    assert_eq!(s2.flags, 0);
    let s3 = a
        .add_ink_stroke_from_samples(
            HIGHLIGHTER,
            0xfacc1559,
            18.0,
            false,
            false,
            line(10.0, 110.0, 250.0),
        )
        .unwrap()
        .unwrap();
    assert_eq!(s3.z, "a0");
    // Nothing drawn, nothing written.
    let empty = InkStrokeBuilder::new(PEN, BLACK, 2.0, false, false);
    assert_eq!(a.add_ink_stroke(empty).unwrap(), None);
    assert!(matches!(
        a.add_ink_stroke_from_samples(PEN, BLACK, 2.0, false, false, vec![1.0, 2.0]),
        Err(InkError::Invalid { .. })
    ));
    wait_for("the strokes on the server", || {
        on_server(&server).len() == 3
    });
    wait_for("the receipt", || a.unsent_updates() == 0);
    wait_for("copy B has them", || b.ink_strokes().len() == 3);
    assert_eq!(sorted(blobs(&a)), sorted(blobs(&b)));
    assert_eq!(sorted(blobs(&a)), sorted(on_server(&server)));
    // Drawing order: the two z = a0 strokes (by id), then a1.
    let order: Vec<String> = a.ink_strokes().into_iter().map(|s| s.z).collect();
    assert_eq!(order, ["a0", "a0", "a1"]);

    // The outline draws: path commands that fill.
    let ops = a.ink_outline(s1.id.clone());
    assert!(ops.len() > 8 && ops.len() == ink_outline_ops(s1.data.clone()).len());
    assert!(ink_outline_svg(s1.data.clone()).starts_with('M'));
    assert!(!ink_outline_triangles(s1.data.clone()).is_empty());

    // Hit tests (read only).
    assert_eq!(
        a.ink_hit_point(60.0, 50.0, 2.0).unwrap(),
        std::slice::from_ref(&s1.id)
    );
    assert!(a.ink_hit_point(60.0, 100.0, 2.0).unwrap().is_empty());
    assert_eq!(
        a.ink_hit_path(vec![60.0, 40.0, 60.0, 160.0], 4.0)
            .unwrap()
            .len(),
        2
    );
    let lasso = vec![0.0, 0.0, 200.0, 0.0, 200.0, 120.0, 0.0, 120.0];
    assert_eq!(a.ink_hit_lasso(lasso.clone(), 0.5).unwrap().len(), 1); // only the first line is inside
    let half = vec![0.0, 0.0, 60.0, 0.0, 60.0, 120.0, 0.0, 120.0];
    assert!(a.ink_hit_lasso(half.clone(), 0.9).unwrap().is_empty());
    assert_eq!(a.ink_hit_lasso(half, 0.3).unwrap().len(), 1);

    // B partially erases across the first line: it is cut in two, nothing else changes.
    let r = b
        .erase_ink(vec![60.0, 30.0, 60.0, 70.0], 8.0, true)
        .unwrap();
    assert_eq!(r.removed, std::slice::from_ref(&s1.id));
    assert_eq!(r.added.len(), 2);
    wait_for("A sees the cut", || {
        a.ink_strokes().len() == 4 && a.ink_strokes().iter().all(|s| s.id != s1.id)
    });
    assert_eq!(sorted(blobs(&a)), sorted(blobs(&b)));
    wait_for("the cut on the server", || {
        sorted(on_server(&server)) == sorted(blobs(&b))
    });

    // A moves the pieces: new ids, same z, 30 right and 5 up.
    let moved = a.move_ink_strokes(r.added.clone(), 30.0, -5.0).unwrap();
    assert_eq!(moved.len(), 2);
    assert!(moved.iter().all(|m| r.added.contains(&m.old_id)));
    let piece =
        |live: &LivePage, id: &str| live.ink_strokes().into_iter().find(|s| s.id == id).unwrap();
    let before = piece(&b, &r.added[0]);
    wait_for("B sees the move", || {
        b.ink_strokes().iter().all(|s| !r.added.contains(&s.id)) && b.ink_strokes().len() == 4
    });
    let after = piece(&b, &moved[0].new_id);
    assert_eq!(after.z, before.z);
    assert_eq!(after.point_count, before.point_count);
    assert_eq!(after.points[0], before.points[0] + 30.0);
    assert_eq!(after.points[1], before.points[1] - 5.0);
    assert_eq!(sorted(blobs(&a)), sorted(blobs(&b)));

    // The stroke eraser takes the second line whole; a track in empty space takes nothing.
    let none = b.erase_ink(vec![300.0, 300.0], 8.0, false).unwrap();
    assert!(none.removed.is_empty() && none.added.is_empty());
    let r2 = b
        .erase_ink(vec![60.0, 140.0, 60.0, 160.0], 8.0, false)
        .unwrap();
    assert_eq!(r2.removed, std::slice::from_ref(&s2.id));
    assert!(r2.added.is_empty());

    // Delete by id: the highlighter, and a missing id is skipped.
    let gone = a
        .delete_ink_strokes(vec![s3.id.clone(), "nope".into()])
        .unwrap();
    assert_eq!(gone, std::slice::from_ref(&s3.id));
    wait_for("both deletes everywhere", || {
        a.ink_strokes().len() == 2 && b.ink_strokes().len() == 2 && on_server(&server).len() == 2
    });
    wait_for("receipts", || {
        a.unsent_updates() == 0 && b.unsent_updates() == 0
    });
    assert_eq!(sorted(blobs(&a)), sorted(blobs(&b)));
    assert_eq!(sorted(blobs(&a)), sorted(on_server(&server)));

    // Bad values, and a closed page.
    assert!(matches!(
        a.erase_ink(vec![1.0], 8.0, false),
        Err(InkError::Invalid { .. })
    ));
    assert!(matches!(
        a.erase_ink(vec![1.0, 1.0], 0.0, false),
        Err(InkError::Invalid { .. })
    ));
    assert!(matches!(
        a.move_ink_strokes(vec![], f32::NAN, 0.0),
        Err(InkError::Invalid { .. })
    ));
    a.close();
    assert_eq!(a.delete_ink_strokes(vec![]), Err(InkError::Closed));
    assert_eq!(
        a.erase_ink(vec![1.0, 1.0], 8.0, true),
        Err(InkError::Closed)
    );
    b.close();
}

#[test]
fn a_stroke_this_build_cannot_read_is_listed_and_survives_every_edit() {
    let server = TestServer::start(&["acc"]);
    let (_c, live) = open_page(&server);
    // A newer app's stroke: version 9, then whatever bytes. Added by another writer.
    let other = Doc::new();
    {
        let mut t = other.transact_mut();
        let ink = t.get_or_insert_map("ink");
        ink.insert(
            &mut t,
            "newer",
            Any::Buffer(vec![9u8, 0, 1, 2, 3, 4].into()),
        );
    }
    live.apply_update(full(&other)).unwrap();
    let list = live.ink_strokes();
    assert_eq!(list.len(), 1);
    assert!(!list[0].readable && list[0].points.is_empty() && list[0].bounds.is_none());
    assert_eq!(list[0].data, [9, 0, 1, 2, 3, 4]);

    let mine = live
        .add_ink_stroke_from_samples(PEN, BLACK, 2.5, false, false, line(0.0, 100.0, 20.0))
        .unwrap()
        .unwrap();
    // Erasing over everything, moving everything and a lasso over everything leave it alone.
    live.erase_ink(vec![-50.0, 20.0, 200.0, 20.0], 30.0, true)
        .unwrap();
    assert!(live.ink_strokes().iter().any(|s| s.id == "newer"));
    let all: Vec<String> = live.ink_strokes().into_iter().map(|s| s.id).collect();
    assert!(live.move_ink_strokes(all, 5.0, 5.0).unwrap().len() <= 2);
    assert!(live
        .ink_hit_lasso(
            vec![-999.0, -999.0, 999.0, -999.0, 999.0, 999.0, -999.0, 999.0],
            0.0
        )
        .unwrap()
        .iter()
        .all(|id| id != "newer"));
    let still = live
        .ink_strokes()
        .into_iter()
        .find(|s| s.id == "newer")
        .unwrap();
    assert_eq!(still.data, [9, 0, 1, 2, 3, 4]);
    wait_for("it reaches the server unchanged", || {
        on_server(&server)
            .iter()
            .any(|(id, b)| id == "newer" && b == &[9, 0, 1, 2, 3, 4])
    });
    // Only an explicit delete removes it.
    assert_eq!(
        live.delete_ink_strokes(vec!["newer".into()]).unwrap(),
        ["newer"]
    );
    let _ = mine;
    live.close();
}
