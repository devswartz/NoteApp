//! Page version history: list, fetch a version's document, and the snapshot taken before a
//! restore. The truth is the server: `server/routes/pages.ts` ("Version history") and
//! `server/versions.ts`. The web restores in the client (`src/editor/VersionHistory.tsx`): the
//! server has no restore route.

use base64::Engine;
use serde_json::{json, Value};

use crate::*;

impl Client {
    /// The page's saved versions, newest first (GET /pages/:id/versions). The server first
    /// takes an automatic snapshot when one is due.
    pub fn page_versions(&self, page_id: &str) -> Result<Vec<PageVersion>, ApiError> {
        self.call(
            "GET",
            &format!("/pages/{}/versions", encode_component(page_id)),
            None,
        )
    }

    /// One version and its document, a Yjs update (GET /pages/:id/versions/:vid).
    pub fn page_version(
        &self,
        page_id: &str,
        version_id: &str,
    ) -> Result<(PageVersion, Vec<u8>), ApiError> {
        let v: Value = self.call(
            "GET",
            &format!(
                "/pages/{}/versions/{}",
                encode_component(page_id),
                encode_component(version_id)
            ),
            None,
        )?;
        let b64 = v["ydoc"]
            .as_str()
            .ok_or_else(|| ApiError::Decode("no ydoc".into()))?;
        let doc = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| ApiError::Decode(e.to_string()))?;
        let meta = serde_json::from_value(v).map_err(|e| ApiError::Decode(e.to_string()))?;
        Ok((meta, doc))
    }

    /// Save the page's stored state as a version now (POST /pages/:id/versions; edit access).
    /// `reason` `restore` marks it as taken before a restore. Answers the new version's id, or
    /// the newest existing one when the content is identical to it (`None` for an empty page).
    pub fn snapshot_page(&self, page_id: &str, reason: &str) -> Result<Option<String>, ApiError> {
        let v: Value = self.call(
            "POST",
            &format!("/pages/{}/versions", encode_component(page_id)),
            Some(&json!({ "reason": reason })),
        )?;
        Ok(v["id"].as_str().map(String::from))
    }
}
