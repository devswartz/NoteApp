//! The y-websocket protocol as today's server speaks it (server/collab.ts), without I/O:
//! message type 0 is sync (step 1: a state vector; step 2: the missing updates; 2: an update),
//! type 1 is awareness (presence: name, colour, cursor). On connect both sides send step 1;
//! each answers the other's with step 2; afterwards every change is an update message.

use std::sync::{Arc, Mutex};

use yrs::sync::{Awareness, Message, SyncMessage};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, Origin, ReadTxn, StateVector, Transact, Update};

/// Transactions applied from the network carry this origin, so they aren't sent back.
pub const REMOTE_ORIGIN: &str = "nv-sync:remote";

#[derive(Debug, Clone, PartialEq)]
pub enum SyncError {
    /// A message this client can't decode or apply.
    Protocol(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Protocol(e) => write!(f, "sync protocol error: {e}"),
        }
    }
}
impl std::error::Error for SyncError {}

/// What handling one incoming message did.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Handled {
    /// Messages to send back, encoded.
    pub replies: Vec<Vec<u8>>,
    /// The document changed.
    pub doc_changed: bool,
    /// Someone's presence changed.
    pub awareness_changed: bool,
    /// This was a step 2 (the answer to a step 1): the document now has everything the server had.
    pub synced: bool,
}

/// One side of a page's sync: its document and awareness, and the protocol rules.
#[derive(Clone)]
pub struct SyncDoc {
    doc: Doc,
    awareness: Arc<Mutex<Awareness>>,
}

pub fn encode(msg: &Message) -> Vec<u8> {
    msg.encode_v1()
}

impl SyncDoc {
    pub fn new(doc: Doc) -> SyncDoc {
        SyncDoc {
            awareness: Arc::new(Mutex::new(Awareness::new(doc.clone()))),
            doc,
        }
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    /// What a client sends when its socket opens: step 1, and its presence if it has one.
    pub fn hello(&self) -> Vec<Vec<u8>> {
        let sv = self.doc.transact().state_vector();
        let mut out = vec![encode(&Message::Sync(SyncMessage::SyncStep1(sv)))];
        let a = self.awareness.lock().unwrap();
        if a.local_state_raw().is_some() {
            if let Ok(u) = a.update_with_clients([a.client_id()]) {
                out.push(encode(&Message::Awareness(u)));
            }
        }
        out
    }

    /// Apply an update that came from the network. Returns whether it changed the document
    /// (a sync step 2 often carries nothing new: only deletions the document already has).
    pub fn apply_remote(&self, update: &[u8]) -> Result<bool, SyncError> {
        let u = Update::decode_v1(update).map_err(|e| SyncError::Protocol(e.to_string()))?;
        let mut txn = self.doc.transact_mut_with(Origin::from(REMOTE_ORIGIN));
        txn.apply_update(u)
            .map_err(|e| SyncError::Protocol(e.to_string()))?;
        Ok(!txn.insert_set().is_empty() || !txn.delete_set().is_empty())
    }

    /// Step 1 with this document's state vector: the server answers with a step 2. A step 1
    /// sent after updates works as a receipt: the server handles a connection's messages in
    /// order, so its answer means it has applied everything sent before.
    pub fn step1(&self) -> Vec<u8> {
        encode(&Message::Sync(SyncMessage::SyncStep1(self.state_vector())))
    }

    pub fn handle(&self, data: &[u8]) -> Result<Handled, SyncError> {
        let msg = Message::decode_v1(data).map_err(|e| SyncError::Protocol(e.to_string()))?;
        let mut out = Handled::default();
        match msg {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let diff = self.doc.transact().encode_state_as_update_v1(&sv);
                out.replies
                    .push(encode(&Message::Sync(SyncMessage::SyncStep2(diff))));
            }
            Message::Sync(SyncMessage::SyncStep2(u)) => {
                out.doc_changed = self.apply_remote(&u)?;
                out.synced = true;
            }
            Message::Sync(SyncMessage::Update(u)) => {
                out.doc_changed = self.apply_remote(&u)?;
            }
            Message::Awareness(u) => {
                self.awareness
                    .lock()
                    .unwrap()
                    .apply_update(u)
                    .map_err(|e| SyncError::Protocol(e.to_string()))?;
                out.awareness_changed = true;
            }
            Message::AwarenessQuery => {
                if let Ok(u) = self.awareness.lock().unwrap().update() {
                    out.replies.push(encode(&Message::Awareness(u)));
                }
            }
            Message::Auth(_) | Message::Custom(..) => {}
        }
        Ok(out)
    }

    /// The message that sends a local update.
    pub fn update_message(update: Vec<u8>) -> Vec<u8> {
        encode(&Message::Sync(SyncMessage::Update(update)))
    }

    /// Set this client's presence (JSON, e.g. `{"user":{"name":…,"color":…}}`); returns the message announcing it.
    pub fn set_presence(&self, json: &str) -> Vec<u8> {
        let mut a = self.awareness.lock().unwrap();
        a.set_local_state_raw(json);
        let u = a
            .update_with_clients([a.client_id()])
            .expect("own state encodes");
        encode(&Message::Awareness(u))
    }

    /// Everyone's presence: (client id, JSON state), this client's included.
    pub fn presence(&self) -> Vec<(u64, String)> {
        let a = self.awareness.lock().unwrap();
        let mut v: Vec<(u64, String)> = a
            .iter()
            .filter_map(|(id, s)| s.data.map(|d| (id.get(), d.to_string())))
            .collect();
        v.sort();
        v
    }

    /// This document's state vector (what it has seen of every client).
    pub fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }
}
