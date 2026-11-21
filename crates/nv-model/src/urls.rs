//! URL checks for content that comes from documents (shared/urls.ts, shared/fileLinks.ts) and the
//! colour palette (shared/colors.ts).

use crate::js;

/// The editor's fixed palette for text colour and highlight (stored by name).
pub const COLOR_NAMES: [&str; 8] = [
    "gray", "red", "orange", "yellow", "green", "blue", "purple", "pink",
];

pub fn is_color_name(v: Option<&str>) -> bool {
    v.is_some_and(|v| COLOR_NAMES.contains(&v))
}

fn is_hex_lower(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A signed upload link (`/uploads/<32 hex>[.ext]?…s=<32 hex>…`, optionally on any http(s) host)
/// as the plain path it's stored as, lowercased.
pub fn unsigned_upload_path(url: &str) -> Option<String> {
    let u = js::trim(url);
    // (?:https?:\/\/[^/?#\s]+)?   case-insensitive
    let mut rest = u;
    let lower = u.to_ascii_lowercase();
    for scheme in ["https://", "http://"] {
        if lower.starts_with(scheme) {
            let after = &u[scheme.len()..];
            let host_len = after
                .find(|c: char| c == '/' || c == '?' || c == '#' || js::is_space(c))
                .unwrap_or(after.len());
            if host_len > 0 {
                rest = &after[host_len..];
            }
            break;
        }
    }
    // (\/uploads\/[0-9a-f]{32}(?:\.[a-z0-9]{1,10})?)\?([^#\s]*)$   case-insensitive
    let q = rest.find('?')?;
    let (path, query) = (&rest[..q], &rest[q + 1..]);
    let p = path.to_ascii_lowercase();
    let name = p.strip_prefix("/uploads/")?;
    let (hex, ext) = match name.split_once('.') {
        Some((h, e)) => (h, Some(e)),
        None => (name, None),
    };
    if hex.len() != 32 || !is_hex_lower(hex) {
        return None;
    }
    if let Some(e) = ext {
        if e.is_empty()
            || e.len() > 10
            || !e
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return None;
        }
    }
    if query.chars().any(|c| c == '#' || js::is_space(c)) {
        return None;
    }
    // (?:^|&)s=[0-9a-f]{32}(?:&|$)   case-sensitive
    if !query.split('&').any(|part| {
        part.strip_prefix("s=")
            .is_some_and(|h| h.len() == 32 && is_hex_lower(h))
    }) {
        return None;
    }
    Some(p)
}

/// `^\/(uploads|files)\/[\w.-]+$`
fn is_upload_path(u: &str) -> bool {
    let rest = u
        .strip_prefix("/uploads/")
        .or_else(|| u.strip_prefix("/files/"));
    rest.is_some_and(|r| {
        !r.is_empty()
            && r.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
    })
}

/// The probe the link and image checks match against: control characters and spaces removed,
/// `\` as `/`, lowercased (browsers ignore those inside schemes and treat `\` like `/`).
fn probe(u: &str) -> String {
    u.chars()
        .filter(|&c| !(c <= ' ' || ('\u{7f}'..='\u{9f}').contains(&c)))
        .map(|c| if c == '\\' { '/' } else { c })
        .collect::<String>()
        .to_lowercase()
}

/// File-card links: our own upload paths and plain http(s) URLs; anything else becomes "".
pub fn safe_file_url(url: Option<&str>) -> String {
    let Some(url) = url else { return String::new() };
    let u = unsigned_upload_path(url).unwrap_or_else(|| js::trim(url).to_string());
    if is_upload_path(&u) {
        return u;
    }
    let lower = u.to_ascii_lowercase();
    let after = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"));
    if after.is_some_and(|a| !a.is_empty() && !a.chars().any(js::is_space)) {
        return u;
    }
    String::new()
}

/// Link hrefs allowed in documents: web, mail and phone links, in-app paths and deep links.
pub fn safe_link_url(url: Option<&str>) -> String {
    let Some(url) = url else { return String::new() };
    let u = js::trim(url);
    let p = probe(u);
    if ["https:", "http:", "mailto:", "tel:", "notivelo:"]
        .iter()
        .any(|s| p.starts_with(s))
    {
        return u.to_string();
    }
    if (p.starts_with('/') && !p[1..].starts_with('/')) || p.starts_with('#') {
        return u.to_string();
    }
    String::new()
}

/// Image sources: our uploads, or plain http(s).
pub fn safe_image_url(url: Option<&str>) -> String {
    let Some(url) = url else { return String::new() };
    let u = unsigned_upload_path(url).unwrap_or_else(|| js::trim(url).to_string());
    if is_upload_path(&u) {
        return u;
    }
    let p = probe(&u);
    if (p.starts_with("http://") || p.starts_with("https://")) && !u.chars().any(js::is_space) {
        return u;
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        for ok in [
            "https://a.b",
            " HTTP://x ",
            "mailto:a@b",
            "tel:1",
            "notivelo://p",
            "/p",
            "#x",
            "/\u{0}x",
        ] {
            assert_ne!(safe_link_url(Some(ok)), "", "{ok:?}");
        }
        for bad in [
            "javascript:x",
            "java\nscript:x",
            "//evil",
            "/\\evil",
            "data:x",
            "",
            "x",
        ] {
            assert_eq!(safe_link_url(Some(bad)), "", "{bad:?}");
        }
        assert_eq!(safe_link_url(None), "");
    }

    #[test]
    fn uploads() {
        let hex = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            unsigned_upload_path(&format!("https://h.example/uploads/{hex}.PNG?e=1&s={hex}")),
            Some(format!("/uploads/{hex}.png"))
        );
        assert_eq!(
            unsigned_upload_path(&format!("/uploads/{hex}?s={hex}")),
            Some(format!("/uploads/{hex}"))
        );
        assert_eq!(
            unsigned_upload_path(&format!("/uploads/{hex}?s=X{hex}")),
            None
        );
        assert_eq!(unsigned_upload_path(&format!("/uploads/{hex}")), None);
        assert_eq!(safe_image_url(Some("https://a.b/c d.png")), "");
        assert_eq!(safe_image_url(Some("/files/a_b.c-d")), "/files/a_b.c-d");
        assert_eq!(safe_file_url(Some("https://")), "");
        assert_eq!(safe_file_url(Some("javascript:alert(1)")), "");
    }
}
