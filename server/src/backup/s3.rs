
use crate::config::Remote;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use url::Url;

type HmacSha256 = Hmac<Sha256>;

pub const MULTIPART_THRESHOLD: u64 = 5 * 1024 * 1024 * 1024;
pub const PART_SIZE: u64 = 64 * 1024 * 1024;
const ATTEMPTS: u32 = 4;

#[derive(Debug, Clone)]
pub struct Object {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
}

#[derive(Debug, thiserror::Error)]
pub enum S3Error {
    #[error("{0}")]
    Config(String),
    #[error("S3 {op} {key}: HTTP {status}: {body}")]
    Status { op: &'static str, key: String, status: u16, body: String },
    #[error("S3 {op} {key}: {source}")]
    Transport { op: &'static str, key: String, source: reqwest::Error },
    #[error("S3 {op} {key}: {msg}")]
    Protocol { op: &'static str, key: String, msg: String },
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl S3Error {
    fn retryable(&self) -> bool {
        match self {
            S3Error::Transport { source, .. } => {
                source.is_timeout() || source.is_connect() || source.is_request() || source.is_body()
            }
            S3Error::Status { status, .. } => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

#[derive(Clone)]
pub struct S3Client {
    http: reqwest::Client,
    endpoint: Url,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
    path_style: bool,
    timeout: Duration,
    pub multipart_threshold: u64,
    pub part_size: u64,
}

enum Body {
    Empty,
    Bytes(Vec<u8>),
    File { path: std::path::PathBuf, offset: u64, len: u64 },
}

impl S3Client {
    pub fn from_config(remote: &Remote) -> Result<Self, S3Error> {
        let (access_key, secret_key) = remote.credentials();
        if access_key.is_empty() || secret_key.is_empty() {
            return Err(S3Error::Config(
                "backup.remote needs access_key_id and secret_access_key (or \
                 TELIUM_S3_ACCESS_KEY_ID / TELIUM_S3_SECRET_ACCESS_KEY)"
                    .into(),
            ));
        }
        if remote.bucket.is_empty() {
            return Err(S3Error::Config("backup.remote.bucket must be set".into()));
        }
        let endpoint = Url::parse(&remote.endpoint)
            .map_err(|e| S3Error::Config(format!("backup.remote.endpoint: {e}")))?;
        if endpoint.host_str().is_none() {
            return Err(S3Error::Config("backup.remote.endpoint has no host".into()));
        }
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(format!("telium-server/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| S3Error::Config(e.to_string()))?;
        Ok(Self {
            http,
            endpoint,
            bucket: remote.bucket.clone(),
            region: remote.region.clone(),
            access_key,
            secret_key,
            path_style: remote.path_style,
            timeout: Duration::from_secs(remote.timeout_secs.max(5)),
            multipart_threshold: MULTIPART_THRESHOLD,
            part_size: PART_SIZE,
        })
    }

    fn locate(&self, key: Option<&str>) -> (String, String) {
        let mut host = self.endpoint.host_str().unwrap_or_default().to_string();
        if let Some(port) = self.endpoint.port() {
            host = format!("{host}:{port}");
        }
        let key_path = key.map(|k| k.split('/').map(uri_encode).collect::<Vec<_>>().join("/"));
        if self.path_style {
            let mut path = format!("/{}", uri_encode(&self.bucket));
            if let Some(k) = key_path {
                path.push('/');
                path.push_str(&k);
            }
            (host, path)
        } else {
            (format!("{}.{host}", self.bucket), format!("/{}", key_path.unwrap_or_default()))
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn request(
        &self,
        op: &'static str,
        method: reqwest::Method,
        key: Option<&str>,
        query: &[(&str, String)],
        body: Body,
        payload_sha256: &str,
        timeout: Duration,
    ) -> Result<reqwest::Response, S3Error> {
        self.request_unsigned_extra(op, method, key, query, body, payload_sha256, timeout, &[]).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn request_unsigned_extra(
        &self,
        op: &'static str,
        method: reqwest::Method,
        key: Option<&str>,
        query: &[(&str, String)],
        body: Body,
        payload_sha256: &str,
        timeout: Duration,
        extra_headers: &[(&str, String)],
    ) -> Result<reqwest::Response, S3Error> {
        let key_label = key.unwrap_or("/").to_string();
        let (host, path) = self.locate(key);
        let mut pairs: Vec<(String, String)> =
            query.iter().map(|(k, v)| (uri_encode(k), uri_encode(v))).collect();
        pairs.sort();
        let canonical_query =
            pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
        let mut url = format!("{}://{host}{path}", self.endpoint.scheme());
        if !canonical_query.is_empty() {
            url.push('?');
            url.push_str(&canonical_query);
        }
        let url = Url::parse(&url).map_err(|e| S3Error::Protocol {
            op,
            key: key_label.clone(),
            msg: format!("building URL: {e}"),
        })?;

        let mut attempt = 0;
        loop {
            attempt += 1;
            let amz_date = amz_date_now();
            let (authorization, content_len) = {
                let content_len = match &body {
                    Body::Empty => 0,
                    Body::Bytes(b) => b.len() as u64,
                    Body::File { len, .. } => *len,
                };
                let headers = [
                    ("host", host.as_str()),
                    ("x-amz-content-sha256", payload_sha256),
                    ("x-amz-date", amz_date.as_str()),
                ];
                (
                    self.authorization(method.as_str(), &path, &canonical_query, &headers, payload_sha256, &amz_date),
                    content_len,
                )
            };
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .timeout(timeout)
                .header("x-amz-content-sha256", payload_sha256)
                .header("x-amz-date", &amz_date)
                .header("authorization", authorization);
            for (name, value) in extra_headers {
                req = req.header(*name, value);
            }
            req = match &body {
                Body::Empty => req.header(reqwest::header::CONTENT_LENGTH, 0),
                Body::Bytes(b) => req.header(reqwest::header::CONTENT_LENGTH, b.len()).body(b.clone()),
                Body::File { path, offset, len } => {
                    let mut f = tokio::fs::File::open(path).await?;
                    f.seek(std::io::SeekFrom::Start(*offset)).await?;
                    let stream = tokio_util::io::ReaderStream::new(f.take(*len));
                    req.header(reqwest::header::CONTENT_LENGTH, content_len)
                        .body(reqwest::Body::wrap_stream(stream))
                }
            };
            let result = match req.send().await {
                Err(source) => Err(S3Error::Transport { op, key: key_label.clone(), source }),
                Ok(resp) if resp.status().is_success() => Ok(resp),
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    Err(S3Error::Status { op, key: key_label.clone(), status, body: snippet(&body) })
                }
            };
            match result {
                Ok(resp) => return Ok(resp),
                Err(e) if e.retryable() && attempt < ATTEMPTS => {
                    let wait = Duration::from_millis(500 * (1u64 << (attempt - 1)));
                    tracing::warn!(target: crate::logcat::BACKUP, %e, attempt, "S3 request failed; retrying");
                    tokio::time::sleep(wait).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn authorization(
        &self,
        method: &str,
        path: &str,
        canonical_query: &str,
        headers: &[(&str, &str)],
        payload_sha256: &str,
        amz_date: &str,
    ) -> String {
        let mut headers: Vec<(&str, &str)> = headers.to_vec();
        headers.sort();
        let canonical_headers: String =
            headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
        let signed_headers = headers.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");
        let canonical_request = format!(
            "{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}"
        );
        let date = &amz_date[..8];
        let scope = format!("{date}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );
        let signature = hex::encode(hmac(&signing_key(&self.secret_key, date, &self.region), string_to_sign.as_bytes()));
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        )
    }

    fn upload_timeout(&self, len: u64) -> Duration {
        self.timeout + Duration::from_secs(len / (256 * 1024))
    }

    pub async fn ensure_bucket(&self) -> Result<bool, S3Error> {
        match self
            .request("HeadBucket", reqwest::Method::HEAD, None, &[], Body::Empty, EMPTY_SHA256, self.timeout)
            .await
        {
            Ok(_) => Ok(false),
            Err(S3Error::Status { status: 403, .. }) => Ok(false),
            Err(S3Error::Status { status: 404, .. }) => {
                let body = if self.region == "us-east-1" {
                    Vec::new()
                } else {
                    format!(
                        "<CreateBucketConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">\
                         <LocationConstraint>{}</LocationConstraint></CreateBucketConfiguration>",
                        self.region
                    )
                    .into_bytes()
                };
                let sha = hex::encode(Sha256::digest(&body));
                self.request("CreateBucket", reqwest::Method::PUT, None, &[], Body::Bytes(body), &sha, self.timeout)
                    .await?;
                Ok(true)
            }
            Err(e) => Err(e),
        }
    }

    pub async fn upload_file(&self, key: &str, path: &Path, sha256: Option<[u8; 32]>) -> Result<(), S3Error> {
        let len = tokio::fs::metadata(path).await?.len();
        if len > self.multipart_threshold {
            return self.upload_multipart(key, path, len).await;
        }
        let digest = match sha256 {
            Some(d) => d,
            None => file_sha256(path, 0, len).await?,
        };
        self.request(
            "PutObject",
            reqwest::Method::PUT,
            Some(key),
            &[],
            Body::File { path: path.to_path_buf(), offset: 0, len },
            &hex::encode(digest),
            self.upload_timeout(len),
        )
        .await?;
        Ok(())
    }

    pub async fn put_bytes(&self, key: &str, bytes: Vec<u8>) -> Result<(), S3Error> {
        let sha = hex::encode(Sha256::digest(&bytes));
        let timeout = self.upload_timeout(bytes.len() as u64);
        self.request("PutObject", reqwest::Method::PUT, Some(key), &[], Body::Bytes(bytes), &sha, timeout).await?;
        Ok(())
    }

    pub async fn get_bytes(&self, key: &str) -> Result<Vec<u8>, S3Error> {
        let resp = self
            .request(
                "GetObject",
                reqwest::Method::GET,
                Some(key),
                &[],
                Body::Empty,
                EMPTY_SHA256,
                self.timeout + Duration::from_secs(300),
            )
            .await?;
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|source| S3Error::Transport { op: "GetObject", key: key.into(), source })
    }

    pub async fn get_bytes_range(&self, key: &str, start: u64, end: u64) -> Result<Vec<u8>, S3Error> {
        let resp = self
            .request_unsigned_extra(
                "GetObject",
                reqwest::Method::GET,
                Some(key),
                &[],
                Body::Empty,
                EMPTY_SHA256,
                self.timeout + Duration::from_secs(300),
                &[("range", format!("bytes={start}-{end}"))],
            )
            .await?;
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|source| S3Error::Transport { op: "GetObject", key: key.into(), source })
    }

    async fn upload_multipart(&self, key: &str, path: &Path, len: u64) -> Result<(), S3Error> {
        let init = self
            .request(
                "CreateMultipartUpload",
                reqwest::Method::POST,
                Some(key),
                &[("uploads", String::new())],
                Body::Empty,
                EMPTY_SHA256,
                self.timeout,
            )
            .await?
            .text()
            .await
            .map_err(|source| S3Error::Transport { op: "CreateMultipartUpload", key: key.into(), source })?;
        let upload_id = xml_tag(&init, "UploadId").ok_or_else(|| S3Error::Protocol {
            op: "CreateMultipartUpload",
            key: key.into(),
            msg: format!("no UploadId in response: {}", snippet(&init)),
        })?;

        let result = self.upload_parts(key, path, len, &upload_id).await;
        if result.is_err() {
            // Best effort: an abandoned multipart upload is billed until someone notices.
            let _ = self
                .request(
                    "AbortMultipartUpload",
                    reqwest::Method::DELETE,
                    Some(key),
                    &[("uploadId", upload_id.clone())],
                    Body::Empty,
                    EMPTY_SHA256,
                    self.timeout,
                )
                .await;
        }
        result
    }

    async fn upload_parts(&self, key: &str, path: &Path, len: u64, upload_id: &str) -> Result<(), S3Error> {
        let part_size = self.part_size.max(1);
        let mut etags: Vec<(u32, String)> = Vec::new();
        let mut offset = 0u64;
        let mut number = 1u32;
        while offset < len {
            let this = part_size.min(len - offset);
            let digest = file_sha256(path, offset, this).await?;
            let resp = self
                .request(
                    "UploadPart",
                    reqwest::Method::PUT,
                    Some(key),
                    &[("partNumber", number.to_string()), ("uploadId", upload_id.to_string())],
                    Body::File { path: path.to_path_buf(), offset, len: this },
                    &hex::encode(digest),
                    self.upload_timeout(this),
                )
                .await?;
            let etag = resp
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .ok_or_else(|| S3Error::Protocol { op: "UploadPart", key: key.into(), msg: "no ETag".into() })?;
            etags.push((number, etag));
            offset += this;
            number += 1;
        }
        let mut body = String::from("<CompleteMultipartUpload>");
        for (n, etag) in &etags {
            body.push_str(&format!("<Part><PartNumber>{n}</PartNumber><ETag>{}</ETag></Part>", xml_escape(etag)));
        }
        body.push_str("</CompleteMultipartUpload>");
        let body = body.into_bytes();
        let sha = hex::encode(Sha256::digest(&body));
        let text = self
            .request(
                "CompleteMultipartUpload",
                reqwest::Method::POST,
                Some(key),
                &[("uploadId", upload_id.to_string())],
                Body::Bytes(body),
                &sha,
                self.timeout,
            )
            .await?
            .text()
            .await
            .map_err(|source| S3Error::Transport { op: "CompleteMultipartUpload", key: key.into(), source })?;
        // S3 may answer 200 and put the error in the body.
        if text.contains("<Error>") {
            return Err(S3Error::Protocol {
                op: "CompleteMultipartUpload",
                key: key.into(),
                msg: snippet(&text),
            });
        }
        Ok(())
    }

    pub async fn list(&self, prefix: &str) -> Result<Vec<Object>, S3Error> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let mut query = vec![("list-type", "2".to_string()), ("prefix", prefix.to_string())];
            if let Some(t) = &token {
                query.push(("continuation-token", t.clone()));
            }
            let text = self
                .request("ListObjectsV2", reqwest::Method::GET, None, &query, Body::Empty, EMPTY_SHA256, self.timeout)
                .await?
                .text()
                .await
                .map_err(|source| S3Error::Transport { op: "ListObjectsV2", key: prefix.into(), source })?;
            for block in xml_blocks(&text, "Contents") {
                let Some(key) = xml_tag(block, "Key") else { continue };
                let size = xml_tag(block, "Size").and_then(|s| s.parse().ok()).unwrap_or(0);
                let last_modified = xml_tag(block, "LastModified").unwrap_or_default();
                out.push(Object { key, size, last_modified });
            }
            let truncated = xml_tag(&text, "IsTruncated").map(|t| t == "true").unwrap_or(false);
            token = xml_tag(&text, "NextContinuationToken");
            if !truncated || token.is_none() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn delete(&self, key: &str) -> Result<(), S3Error> {
        self.request("DeleteObject", reqwest::Method::DELETE, Some(key), &[], Body::Empty, EMPTY_SHA256, self.timeout)
            .await?;
        Ok(())
    }

    pub async fn download(&self, key: &str, dest: &Path) -> Result<(u64, [u8; 32]), S3Error> {
        use futures_util::StreamExt as _;
        let resp = self
            .request(
                "GetObject",
                reqwest::Method::GET,
                Some(key),
                &[],
                Body::Empty,
                EMPTY_SHA256,
                self.timeout + Duration::from_secs(6 * 3600),
            )
            .await?;
        let mut file = tokio::fs::File::create(dest).await?;
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|source| S3Error::Transport { op: "GetObject", key: key.into(), source })?;
            hasher.update(&chunk);
            total += chunk.len() as u64;
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok((total, hasher.finalize().into()))
    }
}

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async fn file_sha256(path: &Path, offset: u64, len: u64) -> Result<[u8; 32], S3Error> {
    let mut f = tokio::fs::File::open(path).await?;
    f.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut f = f.take(len);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

pub fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
    let k = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k = hmac(&k, region.as_bytes());
    let k = hmac(&k, b"s3");
    hmac(&k, b"aws4_request")
}

pub fn uri_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn amz_date_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    amz_date(secs)
}

pub fn amz_date(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn snippet(s: &str) -> String {
    let s = s.trim();
    if s.len() <= 400 {
        return s.to_string();
    }
    let cut = s.char_indices().map(|(i, _)| i).take_while(|i| *i <= 400).last().unwrap_or(0);
    format!("{}…", &s[..cut])
}

pub fn xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    Some(xml_unescape(&xml[start..end]))
}

pub fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(s) = xml[at..].find(&open) {
        let start = at + s + open.len();
        let Some(e) = xml[start..].find(&close) else { break };
        out.push(&xml[start..start + e]);
        at = start + e + close.len();
    }
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amz_dates_are_utc_and_zero_padded() {
        assert_eq!(amz_date(0), "19700101T000000Z");
        assert_eq!(amz_date(1_700_000_000), "20231114T221320Z");
        assert_eq!(amz_date(951_782_400), "20000229T000000Z");
    }

    #[test]
    fn uri_encoding_matches_aws() {
        assert_eq!(uri_encode("telium-1.tbk"), "telium-1.tbk");
        assert_eq!(uri_encode("a b/c"), "a%20b%2Fc");
        assert_eq!(uri_encode("~x_y"), "~x_y");
    }

    #[test]
    fn the_aws_documented_example_signs_the_same() {
        let secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
        let client = S3Client {
            http: reqwest::Client::new(),
            endpoint: Url::parse("https://s3.amazonaws.com").unwrap(),
            bucket: "examplebucket".into(),
            region: "us-east-1".into(),
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: secret.into(),
            path_style: false,
            timeout: Duration::from_secs(1),
            multipart_threshold: MULTIPART_THRESHOLD,
            part_size: PART_SIZE,
        };
        let headers = [
            ("host", "examplebucket.s3.amazonaws.com"),
            ("range", "bytes=0-9"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ];
        let auth = client.authorization("GET", "/test.txt", "", &headers, EMPTY_SHA256, "20130524T000000Z");
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn list_responses_parse() {
        let xml = r#"<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>
        <Contents><Key>telium/a/telium-1.tbk</Key><LastModified>2024-01-01T00:00:00.000Z</LastModified><Size>12</Size></Contents>
        <Contents><Key>telium/a/b&amp;c.tbk</Key><Size>3</Size></Contents></ListBucketResult>"#;
        let blocks = xml_blocks(xml, "Contents");
        assert_eq!(blocks.len(), 2);
        assert_eq!(xml_tag(blocks[0], "Key").unwrap(), "telium/a/telium-1.tbk");
        assert_eq!(xml_tag(blocks[0], "Size").unwrap(), "12");
        assert_eq!(xml_tag(blocks[1], "Key").unwrap(), "telium/a/b&c.tbk");
        assert_eq!(xml_tag(xml, "NextContinuationToken"), None);
    }
}
