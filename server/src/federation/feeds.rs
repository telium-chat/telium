
use super::embed::is_internal;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use std::net::SocketAddr;
use std::time::Duration;

pub fn check_url(state: &AppState, raw: &str) -> ApiResult<url::Url> {
    check_url_loose(raw, state.cfg.federation.allow_http)
}

pub fn check_url_loose(raw: &str, allow_http: bool) -> ApiResult<url::Url> {
    let url = url::Url::parse(raw.trim())
        .map_err(|_| ApiError::BadRequest("feed URL is not a URL".into()))?;
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && allow_http);
    if !scheme_ok {
        return Err(ApiError::BadRequest("feed URLs must be https".into()));
    }
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(ApiError::BadRequest(
            "feed URL needs a host and no credentials".into(),
        ));
    }
    Ok(url)
}

pub async fn fetch(
    state: &AppState,
    raw: &str,
    max_bytes: usize,
    timeout: Duration,
) -> ApiResult<Vec<u8>> {
    let agent = format!(
        "telium-server/{} ({})",
        env!("CARGO_PKG_VERSION"),
        state.cfg.server_name
    );
    fetch_as(state, raw, max_bytes, timeout, &agent).await
}

pub async fn fetch_as(
    state: &AppState,
    raw: &str,
    max_bytes: usize,
    timeout: Duration,
    user_agent: &str,
) -> ApiResult<Vec<u8>> {
    let url = check_url(state, raw)?;
    fetch_bytes(state.cfg.federation.allow_http, url, max_bytes, timeout, user_agent).await
}

async fn pinned_client(
    allow_http: bool,
    host: &str,
    port: u16,
    timeout: Duration,
    user_agent: &str,
) -> ApiResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .connect_timeout(timeout)
        .user_agent(user_agent.to_string());
    if !allow_http {
        let addrs: Vec<SocketAddr> =
            tokio::time::timeout(timeout, tokio::net::lookup_host((host, port)))
                .await
                .map_err(|_| ApiError::BadRequest(format!("timed out resolving {host}")))?
                .map_err(|_| ApiError::BadRequest(format!("cannot resolve {host}")))?
                .collect();
        let Some(first) = addrs.first().copied() else {
            return Err(ApiError::BadRequest(format!("cannot resolve {host}")));
        };
        if addrs.iter().any(|a| is_internal(a.ip())) {
            return Err(ApiError::Forbidden(format!(
                "{host} is not routable from here"
            )));
        }
        builder = builder.resolve(host, first);
    }
    builder
        .build()
        .map_err(|e| ApiError::BadRequest(format!("feed fetch failed: {e}")))
}

pub async fn fetch_bytes(
    allow_http: bool,
    url: url::Url,
    max_bytes: usize,
    timeout: Duration,
    user_agent: &str,
) -> ApiResult<Vec<u8>> {
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let client = pinned_client(allow_http, &host, port, timeout, user_agent).await?;

    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::BadRequest(format!("feed fetch failed: {e}")))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(ApiError::BadRequest(
            "feed URL redirects; subscribe to the address it points at instead".into(),
        ));
    }
    if !status.is_success() {
        return Err(ApiError::BadRequest(format!("feed host answered {status}")));
    }
    let too_large = || ApiError::TooLarge(format!("feed is larger than {max_bytes} bytes"));
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(too_large());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| ApiError::BadRequest(format!("feed read failed: {e}")))?
    {
        if out.len() + chunk.len() > max_bytes {
            return Err(too_large());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

pub async fn post_json(
    allow_http: bool,
    url: url::Url,
    body: Vec<u8>,
    timeout: Duration,
    user_agent: &str,
) -> ApiResult<()> {
    let host = url.host_str().unwrap_or_default().to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let client = pinned_client(allow_http, &host, port, timeout, user_agent).await?;

    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| ApiError::BadRequest(format!("feed fetch failed: {e}")))?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(ApiError::BadRequest(
            "feed URL redirects; subscribe to the address it points at instead".into(),
        ));
    }
    if !status.is_success() {
        return Err(ApiError::BadRequest(format!("feed host answered {status}")));
    }
    Ok(())
}
