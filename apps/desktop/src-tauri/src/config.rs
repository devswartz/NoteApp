//! Which server the app talks to. The web app is bundled (dist/), so only the
//! API is remote. The URL is stored in `<app config dir>/server.json` and handed
//! to the web app before any of its scripts run, as `window.__NOTEAPP_API_URL__`
//! (read by src/api.ts).
//!
//! Precedence: `NOTEAPP_SERVER_URL` env var → saved choice → default. The
//! default is `https://notes.devswartz.com` in release builds and "" (same
//! origin, i.e. the Vite dev server's proxy) in debug builds.

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Runtime};

pub const DEFAULT_SERVER_URL: &str = "https://notes.devswartz.com";

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    server_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// The URL in use ("" = same origin, dev only).
    pub url: String,
    /// Whether the user has confirmed a server yet (drives the first-run screen).
    pub configured: bool,
    pub default_url: String,
}

fn file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("server.json"))
}

fn default_url() -> String {
    if cfg!(debug_assertions) {
        String::new()
    } else {
        DEFAULT_SERVER_URL.to_string()
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> ServerConfig {
    if let Ok(url) = std::env::var("NOTEAPP_SERVER_URL") {
        return ServerConfig { url: normalize(&url).unwrap_or_default(), configured: true, default_url: default_url() };
    }
    let saved: Saved = file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    match saved.server_url {
        Some(url) => ServerConfig { url, configured: true, default_url: default_url() },
        // Debug builds skip the first-run screen and use the Vite proxy.
        None => ServerConfig { url: default_url(), configured: cfg!(debug_assertions), default_url: default_url() },
    }
}

pub fn save<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<String, String> {
    let url = normalize(url)?;
    let path = file(app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&Saved { server_url: Some(url.clone()) }).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(url)
}

/// "notes.example.com/" → "https://notes.example.com". Only http(s) origins
/// (plus an optional path prefix) are accepted. "" means same origin.
pub fn normalize(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Ok(String::new());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&with_scheme).map_err(|_| "That doesn't look like a server address.".to_string())?;
    if u.scheme() != "https" && u.scheme() != "http" {
        return Err("The server address must start with https://".into());
    }
    if u.host_str().is_none() || u.query().is_some() || u.fragment().is_some() {
        return Err("That doesn't look like a server address.".into());
    }
    Ok(u.as_str().trim_end_matches('/').to_string())
}

/// JavaScript run before the web app's own scripts in every window.
pub fn init_script(cfg: &ServerConfig) -> String {
    format!(
        "window.__NOTEAPP_API_URL__ = {};\nwindow.__NOTEAPP_SERVER__ = {};",
        serde_json::to_string(&cfg.url).unwrap(),
        serde_json::to_string(cfg).unwrap()
    )
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn normalizes_server_urls() {
        assert_eq!(normalize("notes.example.com/").unwrap(), "https://notes.example.com");
        assert_eq!(normalize(" https://a.b:8443 ").unwrap(), "https://a.b:8443");
        assert_eq!(normalize("http://localhost:3001").unwrap(), "http://localhost:3001");
        assert_eq!(normalize("https://x.y/noteapp/").unwrap(), "https://x.y/noteapp");
        assert_eq!(normalize("").unwrap(), "");
        assert!(normalize("ftp://x.y").is_err());
        assert!(normalize("https://x.y/?a=1").is_err());
        assert!(normalize("javascript:alert(1)").is_err());
    }
}
