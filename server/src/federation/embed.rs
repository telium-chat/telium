
use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};

pub fn normalise(raw: &str) -> ApiResult<url::Url> {
    let mut url = url::Url::parse(raw).map_err(|_| ApiError::BadRequest("not a URL".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ApiError::BadRequest(
            "only http and https links are proxied".into(),
        ));
    }
    url.set_fragment(None);
    Ok(url)
}

pub fn url_hash(url: &url::Url) -> String {
    blake3::hash(url.as_str().as_bytes()).to_hex().to_string()
}

async fn ssrf_guard(state: &AppState, url: &url::Url) -> ApiResult<Option<SocketAddr>> {
    let host = url
        .host_str()
        .ok_or_else(|| ApiError::BadRequest("URL has no host".into()))?;
    let port = url.port_or_known_default().unwrap_or(80);
    if state.cfg.federation.allow_http {
        return Ok(None);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| ApiError::BadRequest(format!("cannot resolve {host}")))?
        .collect();
    // Check every address: a round-robin name can mix public and internal.
    if addrs.iter().any(|a| is_internal(a.ip())) {
        return Err(ApiError::Forbidden(
            "that host is not routable from here".into(),
        ));
    }
    let Some(first) = addrs.first().copied() else {
        return Err(ApiError::BadRequest(format!("cannot resolve {host}")));
    };
    Ok(Some(first))
}

const MAX_REDIRECTS: u8 = 3;

async fn guarded_get(
    state: &AppState,
    url: &url::Url,
    accept: Option<&str>,
    timeout_secs: u64,
) -> ApiResult<reqwest::Response> {
    let mut current = url.clone();
    for _ in 0..=MAX_REDIRECTS {
        let pinned = ssrf_guard(state, &current).await?;
        let timeout = std::time::Duration::from_secs(timeout_secs);
        let client = match pinned {
            None => state.http_no_redirect.clone(),
            Some(addr) => {
                let host = current.host_str().unwrap_or_default().to_string();
                reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(timeout)
                    // A host dribbling bytes would otherwise hold a worker for all of `timeout_secs`.
                    .connect_timeout(timeout)
                    .resolve(&host, addr)
                    .build()
                    .map_err(|e| ApiError::BadRequest(format!("fetch failed: {e}")))?
            }
        };
        let mut req = client.get(current.clone()).timeout(timeout);
        if let Some(accept) = accept {
            req = req.header(reqwest::header::ACCEPT, accept);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::BadRequest(format!("fetch failed: {e}")))?;
        if resp.status().is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| ApiError::BadRequest("redirect without a location".into()))?;
            let next = current
                .join(location)
                .map_err(|_| ApiError::BadRequest("invalid redirect location".into()))?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(ApiError::BadRequest(
                    "only http and https links are proxied".into(),
                ));
            }
            current = next;
            continue;
        }
        return Ok(resp);
    }
    Err(ApiError::BadRequest("too many redirects".into()))
}

pub(crate) fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || (o[0] == 198 && (18..20).contains(&o[1]))
                || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local, fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link local, fe80::/10
                || (s[0], s[1]) == (0x2001, 0x0db8) // documentation
                || (s[0], s[1]) == (0x2001, 0x0000) // Teredo, 2001::/32
                // NAT64: the well-known prefix embeds the v4 address several ways.
                || (s[0], s[1]) == (0x0064, 0xff9b)
                || embedded_ipv4(v6).is_some_and(|v4| is_internal(IpAddr::V4(v4)))
        }
    }
}

fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = v6.segments();
    let low32 = |s: &[u16; 8]| std::net::Ipv4Addr::from(((s[6] as u32) << 16) | s[7] as u32);

    if s[0..5] == [0, 0, 0, 0, 0] && matches!(s[5], 0 | 0xffff) {
        return Some(low32(&s));
    }
    if s[0] == 0x2002 {
        return Some(std::net::Ipv4Addr::from(
            ((s[1] as u32) << 16) | s[2] as u32,
        ));
    }
    None
}

#[derive(Deserialize)]
pub struct EmbedQuery {
    pub url: String,
}

pub async fn preview(
    State(state): State<AppState>,
    _auth: GuildAuth,
    Query(q): Query<EmbedQuery>,
) -> ApiResult<Json<Value>> {
    if !state.cfg.federation.embed_enabled {
        return Err(ApiError::Forbidden(
            "this server does not proxy link previews".into(),
        ));
    }
    let url = normalise(&q.url)?;
    let hash = url_hash(&url);

    let cached: Option<Cached> = sqlx::query_as(
        "SELECT status, kind, title, description, site, image_hash, video_hash, video_type, \
         video_width, video_height, expires_at FROM embeds WHERE url_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(row) = cached {
        if row.10 > now_ms() {
            let stored = Stored {
                kind: row.1,
                title: row.2,
                description: row.3,
                site: row.4,
                image_hash: row.5,
                video_hash: row.6,
                video_type: row.7,
                video_width: row.8,
                video_height: row.9,
            };
            return Ok(Json(embed_json(&state, &hash, &url, &row.0, stored)));
        }
    }

    let fetched = fetch_metadata(&state, &url).await;
    let (status, meta, error) = match fetched {
        Ok(m) => ("ok", m, None),
        Err(e) => ("error", Metadata::default(), Some(e.to_string())),
    };

    let image_hash = match &meta.image {
        Some(raw) => cache_image(&state, raw).await.ok(),
        None => None,
    };
    let video_hash = match &meta.video {
        Some(raw) => cache_video(&state, raw).await.ok(),
        None => None,
    };
    let (video_type, video_width, video_height) = if video_hash.is_some() {
        (meta.video_type.clone(), meta.video_width, meta.video_height)
    } else {
        (None, None, None)
    };
    let (kind, title, description, site) = (meta.kind, meta.title, meta.description, meta.site);

    sqlx::query(
        "INSERT INTO embeds (url_hash, url, status, kind, title, description, site, image_hash, \
         video_hash, video_type, video_width, video_height, error, fetched_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(url_hash) DO UPDATE SET status = excluded.status, kind = excluded.kind, \
             title = excluded.title, description = excluded.description, site = excluded.site, \
             image_hash = excluded.image_hash, video_hash = excluded.video_hash, \
             video_type = excluded.video_type, video_width = excluded.video_width, \
             video_height = excluded.video_height, error = excluded.error, \
             fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
    )
    .bind(&hash)
    .bind(url.as_str())
    .bind(status)
    .bind(&kind)
    .bind(&title)
    .bind(&description)
    .bind(&site)
    .bind(&image_hash)
    .bind(&video_hash)
    .bind(&video_type)
    .bind(video_width)
    .bind(video_height)
    .bind(&error)
    .bind(now_ms())
    .bind(now_ms() + state.cfg.federation.embed_cache_secs * 1000)
    .execute(&state.pool)
    .await?;

    let stored = Stored {
        kind,
        title,
        description,
        site,
        image_hash,
        video_hash,
        video_type,
        video_width,
        video_height,
    };
    Ok(Json(embed_json(&state, &hash, &url, status, stored)))
}

type Cached = (
    String,         // status
    Option<String>, // kind
    Option<String>, // title
    Option<String>, // description
    Option<String>, // site
    Option<String>, // image_hash
    Option<String>, // video_hash
    Option<String>, // video_type
    Option<i64>,    // video_width
    Option<i64>,    // video_height
    i64,            // expires_at
);

struct Stored {
    kind: Option<String>,
    title: Option<String>,
    description: Option<String>,
    site: Option<String>,
    image_hash: Option<String>,
    video_hash: Option<String>,
    video_type: Option<String>,
    video_width: Option<i64>,
    video_height: Option<i64>,
}

fn embed_json(state: &AppState, hash: &str, url: &url::Url, status: &str, s: Stored) -> Value {
    let camo = |h: String| format!("{}/_telium/v1/camo/{h}", state.cfg.public_base_url);
    let video = s.video_hash.map(camo);
    json!({
        "url": url.as_str(),
        "url_hash": hash,
        "status": status,
        "kind": if video.is_some() { "video".to_string() } else { s.kind.unwrap_or_else(|| "link".into()) },
        "title": s.title,
        "description": s.description,
        "site": s.site.or_else(|| url.host_str().map(str::to_string)),
        "image": s.image_hash.map(camo),
        "video": video,
        "video_type": s.video_type,
        "video_width": s.video_width,
        "video_height": s.video_height,
    })
}

#[derive(Default)]
struct Metadata {
    kind: Option<String>,
    title: Option<String>,
    description: Option<String>,
    site: Option<String>,
    image: Option<String>,
    video: Option<String>,
    video_type: Option<String>,
    video_width: Option<i64>,
    video_height: Option<i64>,
}

async fn fetch_metadata(state: &AppState, url: &url::Url) -> ApiResult<Metadata> {
    let resp = guarded_get(
        state,
        url,
        Some("text/html,application/xhtml+xml"),
        state.cfg.federation.embed_timeout_secs,
    )
    .await?;
    if !resp.status().is_success() {
        return Err(ApiError::BadRequest(format!(
            "origin returned {}",
            resp.status()
        )));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if content_type.starts_with("image/") {
        return Ok(Metadata {
            kind: Some("image".into()),
            site: url.host_str().map(str::to_string),
            image: Some(url.to_string()),
            ..Metadata::default()
        });
    }
    if content_type.starts_with("video/") {
        return Ok(Metadata {
            kind: Some("video".into()),
            site: url.host_str().map(str::to_string),
            video: Some(url.to_string()),
            video_type: Some(
                content_type
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string(),
            ),
            ..Metadata::default()
        });
    }
    if !content_type.contains("html") {
        return Ok(Metadata {
            kind: Some("link".into()),
            site: url.host_str().map(str::to_string),
            ..Metadata::default()
        });
    }

    let body = read_capped(resp, state.cfg.federation.embed_max_bytes).await?;
    let html = String::from_utf8_lossy(&body);
    let (video, video_type) = video_source(&html, url);
    Ok(Metadata {
        kind: Some("link".into()),
        title: meta_content(&html, "og:title")
            .or_else(|| meta_content(&html, "twitter:title"))
            .or_else(|| title_tag(&html))
            .map(clean_text)
            .map(shorten),
        description: meta_content(&html, "og:description")
            .or_else(|| meta_content(&html, "description"))
            .map(clean_text)
            .map(shorten),
        site: meta_content(&html, "og:site_name")
            .map(clean_text)
            .filter(|s| !s.is_empty())
            .map(|s| shorten_to(s, MAX_SITE_NAME))
            .or_else(|| url.host_str().map(str::to_string)),
        image: meta_content(&html, "og:image")
            .or_else(|| meta_content(&html, "twitter:image"))
            .and_then(|i| url.join(&i).ok().map(|u| u.to_string())),
        video,
        video_type,
        video_width: meta_number(&html, "og:video:width")
            .or_else(|| meta_number(&html, "twitter:player:width")),
        video_height: meta_number(&html, "og:video:height")
            .or_else(|| meta_number(&html, "twitter:player:height")),
    })
}

const VIDEO_EXTENSIONS: [&str; 6] = [".mp4", ".m4v", ".webm", ".mov", ".ogv", ".ogg"];

fn video_source(html: &str, base: &url::Url) -> (Option<String>, Option<String>) {
    let declared = meta_content(html, "og:video:type")
        .or_else(|| meta_content(html, "twitter:player:stream:content_type"))
        .map(|t| {
            t.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|t| !t.is_empty());

    for key in [
        "og:video:secure_url",
        "og:video:url",
        "og:video",
        "twitter:player:stream",
    ] {
        let Some(raw) = meta_content(html, key) else {
            continue;
        };
        let Ok(resolved) = base.join(raw.trim()) else {
            continue;
        };
        if !matches!(resolved.scheme(), "http" | "https") {
            continue;
        }
        let path = resolved.path().to_ascii_lowercase();
        let looks_playable = VIDEO_EXTENSIONS.iter().any(|ext| path.ends_with(ext));
        match declared.as_deref() {
            Some(t) if t.starts_with("video/") => {
                return (Some(resolved.to_string()), Some(t.to_string()))
            }
            Some(_) => continue,
            None if looks_playable => return (Some(resolved.to_string()), None),
            None => continue,
        }
    }
    (None, None)
}

async fn read_capped(mut resp: reqwest::Response, cap: usize) -> ApiResult<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| ApiError::BadRequest(format!("read failed: {e}")))?
    {
        out.extend_from_slice(&chunk);
        if out.len() >= cap {
            out.truncate(cap);
            break;
        }
    }
    Ok(out)
}

fn meta_content(html: &str, property: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)<meta[^>]+(?:property|name)\s*=\s*["']{}["'][^>]*content\s*=\s*["']([^"']*)["']"#,
        regex::escape(property)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    if let Some(c) = re.captures(html) {
        return Some(unescape(c.get(1)?.as_str()));
    }
    let pattern = format!(
        r#"(?is)<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["']{}["']"#,
        regex::escape(property)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    re.captures(html)
        .map(|c| unescape(c.get(1).map_or("", |m| m.as_str())))
}

fn meta_number(html: &str, property: &str) -> Option<i64> {
    let raw = meta_content(html, property)?;
    let n: i64 = raw.trim().parse().ok()?;
    (1..=10_000).contains(&n).then_some(n)
}

fn title_tag(html: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    re.captures(html)
        .map(|c| unescape(c.get(1).map_or("", |m| m.as_str()).trim()))
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .chars()
        .take(1000)
        .collect()
}

const MAX_DESCRIPTION: usize = 300;

const MAX_SITE_NAME: usize = 100;

fn shorten(text: String) -> String {
    shorten_to(text, MAX_DESCRIPTION)
}

fn shorten_to(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let kept: String = text.chars().take(max).collect();
    let cut = kept.rfind(char::is_whitespace).unwrap_or(kept.len());
    format!("{}\u{2026}", kept[..cut].trim_end())
}

fn clean_text(text: String) -> String {
    let flattened: String = text
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| {
            !c.is_control()
                && !matches!(*c,
                    '\u{00ad}'                 // soft hyphen
                    | '\u{061c}'               // Arabic letter mark
                    | '\u{180e}'               // Mongolian vowel separator
                    | '\u{200b}'..='\u{200f}' // zero width space .. RLM
                    | '\u{202a}'..='\u{202e}' // LRE, RLE, PDF, LRO, RLO
                    | '\u{2060}'..='\u{2064}' // word joiner and invisible operators
                    | '\u{2066}'..='\u{2069}' // LRI, RLI, FSI, PDI
                    | '\u{feff}'               // zero width no-break space / BOM
                    | '\u{fff9}'..='\u{fffb}' // interlinear annotation
                    | '\u{e0000}'..='\u{e007f}' // tag characters
                )
        })
        .collect();
    let mut out = String::with_capacity(flattened.len());
    let mut last_was_space = false;
    for c in flattened.chars() {
        if c == ' ' {
            if !last_was_space && !out.is_empty() {
                out.push(' ');
            }
            last_was_space = true;
        } else {
            out.push(c);
            last_was_space = false;
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

async fn cache_image(state: &AppState, raw: &str) -> ApiResult<String> {
    cache_media(
        state,
        raw,
        "image/",
        state.cfg.federation.embed_max_bytes,
        false,
    )
    .await
}

async fn cache_video(state: &AppState, raw: &str) -> ApiResult<String> {
    cache_media(
        state,
        raw,
        "video/",
        state.cfg.federation.embed_video_max_bytes,
        true,
    )
    .await
}

async fn cache_media(
    state: &AppState,
    raw: &str,
    prefix: &str,
    cap: usize,
    whole: bool,
) -> ApiResult<String> {
    let url = normalise(raw)?;
    let resp = guarded_get(state, &url, None, state.cfg.federation.embed_timeout_secs).await?;
    if !resp.status().is_success() {
        return Err(ApiError::BadRequest("preview fetch failed".into()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if !mime.starts_with(prefix) || !is_camo_servable(&mime) {
        return Err(ApiError::BadRequest(format!("preview is not {prefix}*")));
    }
    // One byte past the cap tells an exact fit from a truncation.
    let bytes = read_capped(resp, if whole { cap + 1 } else { cap }).await?;
    if whole && bytes.len() > cap {
        return Err(ApiError::BadRequest(
            "preview file is too large to proxy".into(),
        ));
    }
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let path = camo_path(state, &hash);
    // Content-addressed: a half-written file would be a permanently wrong answer.
    crate::objectstore::write_atomically(&path, &bytes)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("writing camo cache: {e}")))?;
    sqlx::query(
        "INSERT INTO media_cache (origin, hash, mime, size, fetched_at, expires_at, hits) \
         VALUES ('camo', ?, ?, ?, ?, ?, 0) \
         ON CONFLICT(origin, hash) DO UPDATE SET expires_at = excluded.expires_at",
    )
    .bind(&hash)
    .bind(&mime)
    .bind(bytes.len() as i64)
    .bind(now_ms())
    .bind(now_ms() + state.cfg.federation.embed_cache_secs * 1000)
    .execute(&state.pool)
    .await?;
    Ok(hash)
}

fn is_camo_servable(mime: &str) -> bool {
    const SERVABLE: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "image/x-icon",
        "image/vnd.microsoft.icon",
        "video/mp4",
        "video/webm",
        "video/ogg",
        "video/quicktime",
        "video/x-m4v",
    ];
    SERVABLE.contains(&mime)
}

fn camo_path(state: &AppState, hash: &str) -> std::path::PathBuf {
    state
        .cfg
        .media_dir
        .join("camo")
        .join(&hash[0..2])
        .join(hash)
}

pub async fn camo(State(state): State<AppState>, Path(hash): Path<String>) -> ApiResult<Response> {
    // `camo_path` slices `&hash[0..2]`, which panics on a multi-byte first character.
    if !crate::routes::media::valid_hash(&hash) {
        return Err(ApiError::NotFound("no such preview".into()));
    }
    let mime: Option<String> =
        sqlx::query_scalar("SELECT mime FROM media_cache WHERE origin = 'camo' AND hash = ?")
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await?;
    let mime = mime.ok_or_else(|| ApiError::NotFound("no such preview".into()))?;
    let bytes = tokio::fs::read(camo_path(&state, &hash))
        .await
        .map_err(|_| ApiError::NotFound("no such preview".into()))?;
    // Old rows may hold unsafe types (`image/svg+xml`); serve unrecognised ones as a download.
    let mime = if is_camo_servable(&mime) {
        mime
    } else {
        "application/octet-stream".to_string()
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        mime.parse()
            .unwrap_or(header::HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    Ok((StatusCode::OK, headers, bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scraped_card_text_cannot_lie_about_its_own_shape() {
        for (raw, want) in [
            ("\u{202e}moc.knab-laer", "moc.knab-laer"), // bidi override
            ("safe\u{202d}\u{202c}evil", "safeevil"),
            ("left\u{2066}right\u{2069}", "leftright"), // bidi isolates
            ("Example\u{200b}\u{200b}Bank", "ExampleBank"), // zero-width
            ("News\u{feff}paper", "Newspaper"),
            ("soft\u{00ad}hyphen", "softhyphen"),
            ("\u{e0041}\u{e0042}plain", "plain"), // tag characters
            ("one\nline\r\ntwo", "one line two"),
            ("tab\there", "tab here"),
            ("   padded\n\n   out   ", "padded out"),
        ] {
            assert_eq!(clean_text(raw.to_string()), want, "{raw:?}");
        }
        for text in [
            "Cafe\u{301} de la Paix",
            "\u{65e5}\u{672c}\u{8a9e}",
            "\u{627}\u{644}\u{639}\u{631}\u{628}\u{64a}\u{629}",
            "\u{1f600} em\u{2014}dash \u{2026}",
        ] {
            assert_eq!(clean_text(text.to_string()), text);
        }
        let long = "n".repeat(5_000);
        let site = shorten_to(clean_text(long.clone()), MAX_SITE_NAME);
        assert!(site.chars().count() <= MAX_SITE_NAME + 1);
        assert!(site.chars().count() < shorten(long).chars().count());
    }

    #[test]
    fn every_way_of_writing_an_inside_address_is_refused() {
        for raw in [
            "127.1.2.3", "0.0.0.0", "0.1.2.3", "10.1.2.3", "172.31.255.254", "192.168.0.1",
            "169.254.169.254", "100.127.255.255", "198.18.0.1", "192.0.2.1", "224.0.0.1",
            "255.255.255.255", "240.0.0.1", "::1", "::", "fdff:ffff::1", "fe80::1", "ff05::2",
            "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1",
            "2002:a9fe:a9fe::", "2001::1", "2001:db8::1",
        ] {
            assert!(is_internal(raw.parse().unwrap()), "{raw} must be refused");
        }
        for raw in [
            "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1",
            "198.20.0.1", "2606:4700::1111", "2002:5db8:d822::", "2003::1",
        ] {
            assert!(!is_internal(raw.parse().unwrap()), "{raw} must stay reachable");
        }
    }

    #[test]
    fn an_svg_is_not_a_servable_camo_image() {
        for t in ["image/svg+xml", "text/html", "application/xhtml+xml", "image/", "image/anything-new"] {
            assert!(!is_camo_servable(t), "{t}");
        }
        assert!(is_camo_servable("image/png") && is_camo_servable("video/mp4"));
    }

    #[test]
    fn open_graph_tags_are_read_either_way_round() {
        let html = r#"<meta property="og:title" content="Hello &amp; welcome">
                      <meta content="A description" name="og:description">"#;
        assert_eq!(meta_content(html, "og:title").unwrap(), "Hello & welcome");
        assert_eq!(
            meta_content(html, "og:description").unwrap(),
            "A description"
        );
    }

    #[test]
    fn open_graph_video_is_read_as_a_playable_file() {
        let base =
            url::Url::parse("https://fixupx.com/xenovacom/status/2100692981632180468").unwrap();
        let html = r#"<meta property="og:video" content="https://video.example/clip.mp4">
                      <meta property="og:video:type" content="video/mp4">
                      <meta property="og:video:width" content="1280">
                      <meta property="og:video:height" content="720">"#;
        let (video, kind) = video_source(html, &base);
        assert_eq!(video.unwrap(), "https://video.example/clip.mp4");
        assert_eq!(kind.unwrap(), "video/mp4");
        assert_eq!(meta_number(html, "og:video:width"), Some(1280));
        assert_eq!(meta_number(html, "og:video:height"), Some(720));
    }

    #[test]
    fn secure_url_wins_and_relative_sources_resolve() {
        let base = url::Url::parse("https://example.com/post/1").unwrap();
        let html = r#"<meta property="og:video" content="http://example.com/a.mp4">
                      <meta property="og:video:secure_url" content="/b.mp4">"#;
        assert_eq!(
            video_source(html, &base).0.unwrap(),
            "https://example.com/b.mp4"
        );
    }

    #[test]
    fn a_page_player_is_not_treated_as_a_video() {
        let base = url::Url::parse("https://example.com/post/1").unwrap();
        let html = r#"<meta name="twitter:player" content="https://example.com/embed/1">
                      <meta name="twitter:player:width" content="640">"#;
        assert_eq!(video_source(html, &base).0, None);
        let html = format!(
            "{html}
{}",
            r#"<meta name="twitter:player:stream" content="https://cdn.example/s.mp4">"#
        );
        assert_eq!(
            video_source(&html, &base).0.unwrap(),
            "https://cdn.example/s.mp4"
        );
    }

    #[test]
    fn a_long_description_is_shortened_where_it_can_say_so() {
        let short = "Two sentences. Both of them short.".to_string();
        assert_eq!(shorten(short.clone()), short);
        let long = "word ".repeat(200);
        let cut = shorten(long);
        assert!(cut.chars().count() <= MAX_DESCRIPTION + 1);
        assert!(cut.ends_with("word\u{2026}"), "{cut}");
    }

    #[test]
    fn non_http_schemes_are_refused() {
        assert!(normalise("file:///etc/passwd").is_err());
        assert!(normalise("https://example.com/x#frag")
            .unwrap()
            .fragment()
            .is_none());
    }
}
