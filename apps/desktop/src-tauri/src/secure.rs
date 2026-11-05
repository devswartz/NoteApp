//! Secrets (the refresh token) in the OS keychain: macOS Keychain, Windows
//! Credential Manager. Entries are namespaced by server URL, so switching
//! servers never sends one server's token to another.

use keyring::Entry;

const SERVICE: &str = "com.devswartz.noteapp";

fn entry(server: &str, key: &str) -> Result<Entry, String> {
    let account = if server.is_empty() { key.to_string() } else { format!("{key}@{server}") };
    Entry::new(SERVICE, &account).map_err(|e| e.to_string())
}

pub fn get(server: &str, key: &str) -> Result<Option<String>, String> {
    match entry(server, key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(server: &str, key: &str, value: &str) -> Result<(), String> {
    entry(server, key)?.set_password(value).map_err(|e| e.to_string())
}

pub fn remove(server: &str, key: &str) -> Result<(), String> {
    match entry(server, key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
