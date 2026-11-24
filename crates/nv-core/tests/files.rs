//! Upload and file links through the Core against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{BinaryResponse, DownloadRequest, Request, Response, Transport, UploadRequest};
use nv_core::*;
use serde_json::{json, Value};

const ID: &str = "0123456789abcdef0123456789abcdef";

#[allow(clippy::type_complexity)]
#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<Response, String>>>>,
    seen: Arc<Mutex<Vec<String>>>,
    sent: Arc<Mutex<Vec<(String, Vec<u8>)>>>,
}

impl Script {
    fn reply(&self, status: u16, body: Value) {
        self.replies.lock().unwrap().push_back(Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        }));
    }
    fn next(&self, what: String) -> Result<Response, String> {
        self.seen.lock().unwrap().push(what.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted request: {what}"))
    }
}

impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.next(format!("{} {}", req.method, req.url))
    }
    fn upload(&self, req: &UploadRequest<'_>) -> Result<Response, String> {
        self.sent
            .lock()
            .unwrap()
            .push((req.filename.clone(), req.data.to_vec()));
        self.next(format!("UPLOAD {}", req.url))
    }
    fn download(&self, req: &DownloadRequest) -> Result<BinaryResponse, String> {
        self.seen.lock().unwrap().push(format!("GET {}", req.url));
        Ok(BinaryResponse {
            status: 200,
            body: b"bytes".to_vec(),
            content_type: Some("application/pdf".into()),
        })
    }
}

fn core() -> (Arc<Core>, Script) {
    let s = Script::default();
    s.reply(
        200,
        json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let core = Core::with_transport("http://localhost:4417", Box::new(s.clone()), None);
    core.sign_in("a@b.c".into(), "pw".into()).unwrap();
    s.seen.lock().unwrap().clear();
    (core, s)
}

#[test]
fn upload_then_link_then_download() {
    let (core, s) = core();
    s.reply(
        200,
        json!({ "id": ID, "url": format!("/uploads/{ID}.pdf"), "name": "a b.pdf", "mime": "application/pdf", "size": 3 }),
    );
    let f = core
        .upload_file(
            "w1".into(),
            Some("p1".into()),
            "a b.pdf".into(),
            vec![1, 2, 3],
        )
        .unwrap();
    assert_eq!(
        f,
        UploadedFile {
            id: ID.into(),
            url: format!("/uploads/{ID}.pdf"),
            name: "a b.pdf".into(),
            mime: "application/pdf".into(),
            size: 3
        }
    );
    assert_eq!(
        s.seen.lock().unwrap().last().unwrap(),
        "UPLOAD http://localhost:4417/api/workspaces/w1/files?pageId=p1"
    );
    assert_eq!(
        s.sent.lock().unwrap()[0],
        ("a%20b.pdf".to_string(), vec![1, 2, 3])
    );

    s.reply(200, json!({ "u": "u1", "e": 4_000_000_000u64, "k": "kk" }));
    let link = core.file_url(f.url.clone()).unwrap();
    assert!(link.starts_with("http://localhost:4417/uploads/"), "{link}");
    assert!(link.contains("?u=u1&e=4000000000&s="), "{link}");
    let got = core.download_file(f.url).unwrap();
    assert_eq!(
        (got.bytes, got.mime.as_str()),
        (b"bytes".to_vec(), "application/pdf")
    );
    // One key request for both.
    assert_eq!(
        s.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.ends_with("/api/files/key"))
            .count(),
        1
    );
}

#[test]
fn too_large_is_a_clear_error_before_sending() {
    let (core, s) = core();
    let e = core
        .upload_file(
            "w1".into(),
            None,
            "big.mov".into(),
            vec![0; 25 * 1024 * 1024 + 1],
        )
        .unwrap_err();
    match e {
        CoreError::Server {
            status,
            message,
            code,
        } => {
            assert_eq!(status, 413);
            assert_eq!(code.as_deref(), Some("file_too_large"));
            assert!(
                message.contains("big.mov") && message.contains("25 MB"),
                "{message}"
            );
        }
        e => panic!("{e:?}"),
    }
    assert!(s.seen.lock().unwrap().is_empty());
}
