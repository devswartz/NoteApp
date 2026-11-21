//! Live page sync (docs/ARCHITECTURE.md 3.5): yrs documents over today's y-websocket protocol
//! (server/collab.ts), with awareness for presence. Nothing changes on the wire, so native and
//! web clients edit the same pages live.
//!
//! `protocol` is the message logic without I/O; `live` runs it over a socket on its own thread.

pub mod live;
pub mod protocol;

pub use live::{ConnectError, Listener, LiveDoc, Status};
pub use protocol::{Handled, SyncDoc, SyncError, REMOTE_ORIGIN};
pub use yrs;
