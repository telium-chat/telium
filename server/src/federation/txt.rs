//! A website may delegate its account domain with one line at /telium.txt.
//! This is a *pointer*, not an HTTP redirect; live metadata comes from the API.

use crate::federation::{dialable_server_name, normalise_origin};
use crate::state::AppState;
use serde_json::Value;
use std::time::Duration;

const POINTER_LIMIT: usize = 512;

/// Accept only an HTTPS origin on the identity domain or one of its subdomains.
/// Reject URL paths, credentials, query strings, malformed lines and lookalike hosts.
pub(crate) fn parse_pointer(text: &str, identity: &str, allow_http: bool) -> Option<String> {
    if text.len() > POINTER_LIMIT || text.contains(['\n', '\r']) {
        return None;
    }
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    let target = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = reqwest::Url::parse(&target).ok()?;
    if url.scheme() != "https" && !(allow_http && url.scheme() == "http") {
        return None;
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let identity = normalise_origin(identity);
    let identity_host = identity.split(':').next()?;
    if host != identity_host && !host.ends_with(&format!(".{identity_host}")) {
        return None;
    }
    if url.port().is_some() && !allow_http {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Read only a small, fixed-path pointer and then the backend's *full* discovery
/// document. Always assert that it belongs to the requested account identity.
pub(crate) async fn discover_through_txt(
    state: &AppState,
    seed: &str,
    identity: &str,
) -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let mut response = client
        .get(format!("{seed}/telium.txt"))
        .send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mut body = Vec::new();
    while let Some(part) = response.chunk().await.ok()? {
        if body.len().saturating_add(part.len()) > POINTER_LIMIT {
            return None;
        }
        body.extend_from_slice(&part);
    }
    let pointer = std::str::from_utf8(&body).ok()?;
    let target = parse_pointer(pointer, identity, state.cfg.federation.allow_http)?;
    let parsed = reqwest::Url::parse(&target).ok()?;
    let authority = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str()?),
        None => parsed.host_str()?.to_string(),
    };
    dialable_server_name(state, &authority).ok()?;
    let response = client
        .get(format!("{target}/.well-known/telium/server"))
        .send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let doc = super::json_capped(response, super::FED_JSON_MAX_BYTES, identity).await.ok()?;
    if doc.get("server_name").and_then(Value::as_str) != Some(identity) {
        return None;
    }
    // The backend must publish the same endpoint the owner delegated to.
    if doc.get("api").and_then(Value::as_str)?.trim_end_matches('/') != target {
        return None;
    }
    Some(doc)
}

#[cfg(test)]
mod tests {
    use super::parse_pointer;

    #[test]
    fn short_text_can_delegate_to_a_subdomain() {
        assert_eq!(
            parse_pointer("chat.example.com\n".trim_end_matches('\n'), "example.com", false),
            Some("https://chat.example.com".into())
        );
        assert_eq!(
            parse_pointer("https://chat.example.com", "example.com", false),
            Some("https://chat.example.com".into())
        );
    }

    #[test]
    fn dangerous_or_ambiguous_pointers_are_refused() {
        for bad in [
            "https://attacker.com", "https://evil-example.com", "http://chat.example.com",
            "https://127.0.0.1", "https://chat.example.com@attacker.com",
            "https://chat.example.com/path", "https://chat.example.com?secret=1",
            "https://chat.example.com\nhttps://attacker.com",
            "https://chat.example.com:8080", "ftp://chat.example.com",
        ] {
            assert!(parse_pointer(bad, "example.com", false).is_none(), "{bad}");
        }
    }
}
