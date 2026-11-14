//! Which server the app talks to. The web app is bundled (dist/), so only the
//! API is remote. The URL is handed to the web app before any of its scripts
//! run, as `window.__NOTEAPP_API_URL__` (read by src/api.ts).
//!
//! Release builds are locked to `DEFAULT_SERVER_URL`: no first-run screen, no
//! "Change Server…", and `NOTEAPP_SERVER_URL` is ignored. Builds that may switch
//! (debug builds, or a release built with `NOTEAPP_ALLOW_SERVER_SWITCH=1` for
//! internal testing) use: `NOTEAPP_SERVER_URL` env var → the choice saved in
//! `<app config dir>/server.json` → default ("" = same origin, i.e. the Vite dev
//! server's proxy, in debug builds; `DEFAULT_SERVER_URL` otherwise).
//!
//! Older versions saved a server choice. A locked build removes it on start
//! (`migrate`): a session for the production server is kept (moved to the new
//! keychain namespace); one for any other server is signed out. Hosts that count
//! as "production" besides the default come from `LEGACY_PROD_HOSTS` at build
//! time (comma-separated, set by CI; see docs/RELEASING.md).

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Runtime};

pub const DEFAULT_SERVER_URL: &str = "https://app.notiveloapp.com";

/// Keychain keys that belong to a server (see src/api.ts).
const SESSION_KEYS: &[&str] = &["noteapp.refreshToken"];

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    server_url: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    /// The URL in use ("" = same origin, dev only).
    pub url: String,
    /// Whether this build offers "Change Server…" (debug / internal builds only).
    pub switchable: bool,
    pub default_url: String,
}

/// Debug builds, or builds made with `NOTEAPP_ALLOW_SERVER_SWITCH=1`.
pub fn switchable() -> bool {
    cfg!(debug_assertions) || matches!(option_env!("NOTEAPP_ALLOW_SERVER_SWITCH"), Some("1"))
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

fn read_saved<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Saved>(&s).ok())
        .and_then(|s| s.server_url)
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> ServerConfig {
    if !switchable() {
        return ServerConfig { url: DEFAULT_SERVER_URL.into(), switchable: false, default_url: DEFAULT_SERVER_URL.into() };
    }
    let url = match std::env::var("NOTEAPP_SERVER_URL") {
        Ok(url) => normalize(&url).unwrap_or_default(),
        Err(_) => read_saved(app).unwrap_or_else(default_url),
    };
    ServerConfig { url, switchable: true, default_url: default_url() }
}

pub fn save<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<String, String> {
    if !switchable() {
        return Err("This build always uses the Notivelo server.".into());
    }
    let url = normalize(url)?;
    let path = file(app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&Saved { server_url: Some(url.clone()) }).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(url)
}

/// What to do with a server choice saved by an older version.
#[derive(Debug, PartialEq)]
pub enum Stale {
    /// It was the locked server: nothing to move.
    Same,
    /// The old production host: keep the session (move it to the locked server's namespace).
    KeepSession,
    /// Another server: its session doesn't belong here, sign out.
    SignOut,
}

/// Classifies a saved server URL. `legacy` is the comma-separated LEGACY_PROD_HOSTS list.
pub fn classify_stale(saved: &str, legacy: &str) -> Stale {
    let Ok(url) = normalize(saved) else { return Stale::SignOut };
    if url == DEFAULT_SERVER_URL {
        return Stale::Same;
    }
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase));
    let legacy_hosts: Vec<String> = legacy
        .split(',')
        .map(|h| h.trim().trim_end_matches('/').to_ascii_lowercase())
        .map(|h| h.strip_prefix("https://").map(str::to_string).unwrap_or(h))
        .filter(|h| !h.is_empty())
        .collect();
    match host {
        Some(h) if url.starts_with("https://") && legacy_hosts.contains(&h) => Stale::KeepSession,
        _ => Stale::SignOut,
    }
}

/// Locked builds: forget a server choice saved by an older version (runs once at start-up,
/// before any window exists). Keeps or signs out its session as `classify_stale` says.
pub fn migrate<R: Runtime>(app: &AppHandle<R>) {
    if switchable() {
        return;
    }
    let Some(path) = file(app) else { return };
    if !path.exists() {
        return;
    }
    let saved = read_saved(app);
    let _ = fs::remove_file(&path);
    let Some(saved) = saved else { return };
    let action = classify_stale(&saved, option_env!("LEGACY_PROD_HOSTS").unwrap_or(""));
    for key in SESSION_KEYS {
        match action {
            Stale::Same => {}
            Stale::KeepSession => {
                if let Ok(Some(v)) = crate::secure::get(&saved, key) {
                    let _ = crate::secure::set(DEFAULT_SERVER_URL, key, &v);
                }
                let _ = crate::secure::remove(&saved, key);
            }
            Stale::SignOut => {
                let _ = crate::secure::remove(&saved, key);
                // A token stored under the locked server's name now would be a stale one too.
                let _ = crate::secure::remove(DEFAULT_SERVER_URL, key);
            }
        }
    }
}

/// "notes.example.com/" → "https://notes.example.com". Only https origins (plus
/// an optional path prefix) are accepted; http only for localhost/127.0.0.1.
/// "" means same origin.
pub fn normalize(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Ok(String::new());
    }
    let with_scheme = if s.contains("://") { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&with_scheme).map_err(|_| "That doesn't look like a server address.".to_string())?;
    let host = u.host_str().ok_or("That doesn't look like a server address.")?;
    if u.query().is_some() || u.fragment().is_some() {
        return Err("That doesn't look like a server address.".into());
    }
    // Tokens travel with every request, so plain http is only allowed to this machine.
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match u.scheme() {
        "https" => {}
        "http" if local => {}
        _ => return Err("The server address must start with https://".into()),
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
    use super::{classify_stale, normalize, switchable, Stale, DEFAULT_SERVER_URL};

    #[test]
    fn normalizes_server_urls() {
        assert_eq!(normalize("notes.example.com/").unwrap(), "https://notes.example.com");
        assert_eq!(normalize(" https://a.b:8443 ").unwrap(), "https://a.b:8443");
        assert_eq!(normalize("http://localhost:3001").unwrap(), "http://localhost:3001");
        assert_eq!(normalize("https://x.y/noteapp/").unwrap(), "https://x.y/noteapp");
        assert_eq!(normalize("").unwrap(), "");
        assert_eq!(normalize("http://127.0.0.1:3001/").unwrap(), "http://127.0.0.1:3001");
        assert!(normalize("http://notes.example.com").is_err());
        assert!(normalize("http://localhost.evil.com").is_err());
        assert!(normalize("ftp://x.y").is_err());
        assert!(normalize("https://x.y/?a=1").is_err());
        assert!(normalize("javascript:alert(1)").is_err());
    }

    #[test]
    fn classifies_stale_server_choices() {
        assert_eq!(classify_stale(DEFAULT_SERVER_URL, ""), Stale::Same);
        assert_eq!(classify_stale("app.notiveloapp.com/", ""), Stale::Same);
        assert_eq!(classify_stale("https://old.example.com", ""), Stale::SignOut);
        assert_eq!(classify_stale("https://old.example.com", "x.example, OLD.example.com"), Stale::KeepSession);
        assert_eq!(classify_stale("https://old.example.com", "https://old.example.com/"), Stale::KeepSession);
        assert_eq!(classify_stale("https://staging.example.com", "old.example.com"), Stale::SignOut);
        assert_eq!(classify_stale("http://localhost:3001", "localhost"), Stale::SignOut);
        assert_eq!(classify_stale("not a url", "old.example.com"), Stale::SignOut);
    }

    #[test]
    fn debug_builds_can_switch() {
        assert_eq!(switchable(), cfg!(debug_assertions) || option_env!("NOTEAPP_ALLOW_SERVER_SWITCH") == Some("1"));
    }
}
