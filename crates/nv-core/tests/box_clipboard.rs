//! Box clipboard, duplicate and template content on a live page. Stand-in collab server as in tests/page_undo.rs.

#[path = "../../nv-sync/tests/support/mod.rs"]
mod support;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_core::*;
use support::{read_text, wait_for, TestServer};

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

fn text(live: &LivePage, id: &str) -> String {
    let doc = nv_model::doc_from_update(&live.document()).unwrap();
    read_text(&doc, &format!("box:{id}"))
}

fn geom(live: &LivePage, id: &str) -> (f64, f64, f64, f64) {
    let b = live.info().boxes.into_iter().find(|b| b.id == id).unwrap();
    (b.x, b.y, b.w, b.z)
}

const HELLO: &str = "<paragraph>Hello <bold>world</bold></paragraph>";

const CLIP: &str = r#"{"boxes":[
  {"x":100,"y":200,"w":300,"content":[{"type":"paragraph","content":[{"type":"text","text":"Hello "},{"type":"text","text":"world","marks":[{"type":"bold"}]}]}]},
  {"x":500,"y":250,"w":240,"content":[{"type":"taskRef","attrs":{"taskId":"t-old"},"content":[{"type":"paragraph"}]}]}
],"text":"","cut":false}"#;

#[test]
fn copy_paste_duplicate_and_undo() {
    let server = TestServer::start(&["acc"]);
    let (_core, live) = open_page(&server);
    let before = live.info().boxes.len();

    // Paste at a point: the group's top-left lands there, geometry relative to each other kept.
    let ids = live
        .paste_boxes(CLIP.into(), Some(10.0), Some(20.0), Default::default())
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(live.info().boxes.len(), before + 2);
    assert_eq!(geom(&live, &ids[0]).0, 10.0);
    assert_eq!(geom(&live, &ids[0]).1, 20.0);
    assert_eq!(geom(&live, &ids[1]).0, 410.0);
    assert_eq!(geom(&live, &ids[1]).1, 70.0);
    assert_eq!(geom(&live, &ids[0]).2, 300.0);
    assert!(geom(&live, &ids[1]).3 > geom(&live, &ids[0]).3);
    assert_eq!(text(&live, &ids[0]), HELLO);

    // Copy: the web's clip shape, boxes in the order asked.
    let clip: serde_json::Value = serde_json::from_str(
        &live
            .boxes_json(vec![ids[1].clone(), ids[0].clone()])
            .unwrap(),
    )
    .unwrap();
    assert_eq!(clip["cut"], false);
    assert_eq!(clip["boxes"][0]["x"], 410.0);
    assert_eq!(
        clip["boxes"][1]["content"][0]["content"][1]["marks"][0]["type"],
        "bold"
    );
    assert_eq!(clip["boxes"][0]["content"][0]["attrs"]["taskId"], "t-old");
    assert!(clip["text"].as_str().unwrap().contains("Hello world"));
    assert_eq!(
        live.boxes_json(vec!["nope".into()]).unwrap_err(),
        BoxError::NoSuchBox { id: "nope".into() }
    );

    // Duplicate: same place nudged by 24, one undo step, same text.
    let dup = live.duplicate_boxes(vec![ids[0].clone()]).unwrap();
    assert_eq!(dup.len(), 1);
    assert_eq!(geom(&live, &dup[0]).0, 34.0);
    assert_eq!(geom(&live, &dup[0]).1, 44.0);
    assert_eq!(text(&live, &dup[0]), HELLO);
    let dup2 = live.duplicate_boxes(vec![ids[0].clone()]).unwrap();
    assert_eq!(geom(&live, &dup2[0]).0, 58.0);

    // Undo takes each paste away whole, then the first one; redo brings it back with its text.
    assert!(live.undo().unwrap());
    assert!(!live.info().boxes.iter().any(|b| b.id == dup2[0]));
    assert!(live.undo().unwrap());
    assert!(!live.info().boxes.iter().any(|b| b.id == dup[0]));
    assert!(live.undo().unwrap());
    assert_eq!(live.info().boxes.len(), before);
    assert!(live.redo().unwrap());
    assert_eq!(live.info().boxes.len(), before + 2);
    assert_eq!(text(&live, &ids[0]), HELLO);

    // A task map gives the copy its own tasks; the clip as a bare array works too.
    let map = [("t-old".to_string(), "t-new".to_string())].into();
    let p = live
        .paste_boxes(r#"[{"x":0,"y":0,"w":200,"content":[{"type":"taskRef","attrs":{"taskId":"t-old"},"content":[{"type":"paragraph"}]}]}]"#.into(), Some(0.0), Some(0.0), map)
        .unwrap();
    let c: serde_json::Value = serde_json::from_str(&live.boxes_json(p.clone()).unwrap()).unwrap();
    assert_eq!(c["boxes"][0]["content"][0]["attrs"]["taskId"], "t-new");
}

#[test]
fn bad_clips_change_nothing() {
    let server = TestServer::start(&["acc"]);
    let (_core, live) = open_page(&server);
    let before = live.info().boxes.len();
    for bad in [
        "not json",
        "{}",
        r#"{"boxes":[{"x":1,"y":1,"w":200,"content":[{"type":"nonsense"}]}]}"#,
    ] {
        assert!(matches!(
            live.paste_boxes(bad.into(), None, None, Default::default()),
            Err(BoxError::Invalid { .. })
        ));
    }
    assert_eq!(live.info().boxes.len(), before);
    live.close();
    assert_eq!(live.duplicate_boxes(vec![]).unwrap_err(), BoxError::Closed);
}

#[test]
fn template_content_in_and_out() {
    let server = TestServer::start(&["acc"]);
    let (_core, live) = open_page(&server);
    let tpl = r##"{"type":"doc","attrs":{"pageSettings":{"color":"yellow","rules":"grid"}},"content":[
      {"type":"canvasBox","attrs":{"x":40,"y":60,"w":400,"z":1,"wide":true},"content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Notes {date}"}]}]},
      {"type":"canvasBox","attrs":{"x":500,"y":60,"w":260,"z":2},"content":[{"type":"paragraph","content":[{"type":"text","text":"at {TIME}"}]}]}]}"##;
    let ids = live
        .insert_template_content(
            tpl.into(),
            "canvas".into(),
            "Tuesday".into(),
            "3:45 PM".into(),
        )
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(
        text(&live, &ids[0]),
        "<heading level=\"1\">Notes Tuesday</heading>"
    );
    assert_eq!(text(&live, &ids[1]), "<paragraph>at 3:45 PM</paragraph>");
    assert_eq!(geom(&live, &ids[0]).0, 40.0);
    assert!(geom(&live, &ids[1]).3 > geom(&live, &ids[0]).3);
    let s = live.info().settings;
    assert_eq!((s.color.as_str(), s.rules.as_str()), ("yellow", "grid"));

    // The page back as template content: boxes in reading order, settings kept.
    let out: serde_json::Value = serde_json::from_str(&live.canvas_template_json()).unwrap();
    assert_eq!(out["type"], "doc");
    assert_eq!(out["attrs"]["pageSettings"]["rules"], "grid");
    let boxes = out["content"].as_array().unwrap();
    assert!(boxes.iter().all(|b| b["type"] == "canvasBox"));
    assert!(boxes.iter().any(|b| b["content"][0]["type"] == "heading"));

    // One undo takes the template back out (boxes and settings).
    assert!(live.undo().unwrap());
    assert!(!live.info().boxes.iter().any(|b| ids.contains(&b.id)));
    assert_eq!(live.info().settings.color, "none");

    // A document template becomes one wide box.
    let doc = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"plain"}]}]}"#;
    let d = live
        .insert_template_content(doc.into(), "document".into(), "".into(), "".into())
        .unwrap();
    assert_eq!(d.len(), 1);
    assert_eq!(text(&live, &d[0]), "<paragraph>plain</paragraph>");
    assert!(live.info().boxes.iter().any(|b| b.id == d[0] && b.wide));
}
