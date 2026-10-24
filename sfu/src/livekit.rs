
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::config::{LivekitConfig, LivekitMode, SfuConfig};

/// Escape to valid LiveKit room-name characters, deterministically (`/session` and `/control` must agree).
pub fn sanitize_room_part(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() {
            out.push(b as char);
        } else {
            // Output alphabet excludes `_`, so `room_name` can use it as a separator.
            out.push('-');
            out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
            out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
        }
    }
    out
}

/// Must be injective: it is the only isolation between origins on a shared SFU.
pub fn room_name(origin: &str, guild: &str, channel: &str) -> String {
    format!(
        "telium_{}_{}_{}",
        sanitize_room_part(origin),
        sanitize_room_part(guild),
        sanitize_room_part(channel)
    )
}

#[derive(Serialize)]
struct LivekitYaml {
    port: u16,
    bind_addresses: Vec<String>,
    rtc: RtcYaml,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: Option<TurnYaml>,
    room: RoomYaml,
    keys: HashMap<String, String>,
}

#[derive(Serialize)]
struct RtcYaml {
    port_range_start: u16,
    port_range_end: u16,
    tcp_port: u16,
    use_external_ip: bool,
}

#[derive(Serialize)]
struct TurnYaml {
    enabled: bool,
    udp_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    tls_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cert_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_file: Option<String>,
}

#[derive(Serialize)]
struct RoomYaml {
    empty_timeout: u32,
    max_participants: u32,
}

pub struct LivekitManager {
    pub url: String,
    pub public_url: String,
    pub api_key: String,
    pub api_secret: String,
    host: String,
    port: u16,
}

impl LivekitManager {
    pub async fn start(cfg: &SfuConfig, shutdown: watch::Receiver<bool>) -> Result<Arc<Self>> {
        let lk = &cfg.livekit;
        let port = parse_port(&lk.url).unwrap_or(7880);
        let host = parse_host(&lk.url).unwrap_or_else(|| "127.0.0.1".to_string());

        let (api_key, api_secret) = resolve_keys(lk);
        let url = lk.url.clone();
        let public_url = lk.public_url.clone();

        let manager = Arc::new(LivekitManager { url, public_url, api_key, api_secret, host, port });

        match lk.mode {
            LivekitMode::External => {
                tracing::info!(url = %manager.url, "using external LiveKit (no process managed)");
            }
            LivekitMode::Spawn => {
                let yaml = build_yaml(lk, &manager.api_key, &manager.api_secret, port);
                let dir = if lk.config_dir.is_empty() { "." } else { &lk.config_dir };
                std::fs::create_dir_all(dir)
                    .with_context(|| format!("creating livekit config dir {dir}"))?;
                let path = Path::new(dir).join("livekit.yaml");
                let yaml_str =
                    serde_yaml::to_string(&yaml).context("serializing livekit.yaml")?;
                write_private(&path, &yaml_str)
                    .with_context(|| format!("writing {}", path.display()))?;
                tracing::info!(path = %path.display(), "generated livekit.yaml");

                let m = Arc::clone(&manager);
                let lk_cfg = lk.clone();
                tokio::spawn(async move {
                    supervise(m, lk_cfg, path, shutdown).await;
                });
            }
        }

        Ok(manager)
    }

    pub async fn health(&self) -> bool {
        let addr = format!("{}:{}", self.host, self.port);
        match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(&addr)).await {
            Ok(Ok(_)) => true,
            _ => false,
        }
    }

    pub fn connect_url(&self) -> String {
        let source = if self.public_url.is_empty() { &self.url } else { &self.public_url };
        if let Ok(u) = url::Url::parse(source) {
            let scheme = match u.scheme() {
                "https" => "wss",
                _ => "ws",
            };
            let host = u.host_str().unwrap_or("127.0.0.1");
            let explicit_port = u.port();
            return match explicit_port {
                Some(port) => format!("{scheme}://{host}:{port}"),
                None => format!("{scheme}://{host}"),
            };
        }
        source.clone()
    }

    /// Sources are admitted only when the join token names them; `max_bitrate` is an attribute the participant cannot rewrite.
    pub fn mint_token(
        &self,
        room: &str,
        identity: &str,
        flags: &JoinFlags,
        exp_secs: i64,
        max_bitrate: i64,
    ) -> Result<String> {
        let mut sources = Vec::new();
        if flags.speak { sources.push("microphone".to_string()); }
        if flags.video { sources.push("camera".to_string()); }
        if flags.stream {
            sources.push("screen_share".to_string());
            sources.push("screen_share_audio".to_string());
        }
        let grant = VideoGrant {
            room: room.to_string(),
            room_join: true,
            can_publish: !sources.is_empty(),
            can_subscribe: true,
            can_publish_data: true,
            can_publish_sources: sources,
            room_admin: false,
        };
        let mut attributes = HashMap::new();
        attributes.insert(
            telium_protocol::MAX_BITRATE_ATTRIBUTE.to_string(),
            max_bitrate.to_string(),
        );
        self.encode_token(grant, identity, exp_secs, attributes)
    }

    pub fn admin_token(&self, room: &str) -> Result<String> {
        let grant = VideoGrant {
            room: room.to_string(),
            room_join: false,
            can_publish: false,
            can_subscribe: false,
            can_publish_data: false,
            can_publish_sources: Vec::new(),
            room_admin: true,
        };
        self.encode_token(grant, "telium-sfu", 300, HashMap::new())
    }

    fn encode_token(
        &self,
        grant: VideoGrant,
        sub: &str,
        exp_secs: i64,
        attributes: HashMap<String, String>,
    ) -> Result<String> {
        let now = now_secs();
        let claims = LkClaims {
            iss: self.api_key.clone(),
            sub: sub.to_string(),
            nbf: now,
            iat: now,
            exp: now + exp_secs,
            video: grant,
            attributes,
        };
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
        header.typ = Some("JWT".into());
        jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(self.api_secret.as_bytes()),
        )
        .context("encoding livekit access token")
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct JoinFlags {
    pub speak: bool,
    pub video: bool,
    pub stream: bool,
    #[allow(dead_code)]
    pub priority: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    room: String,
    room_join: bool,
    can_publish: bool,
    can_subscribe: bool,
    can_publish_data: bool,
    can_publish_sources: Vec<String>,
    room_admin: bool,
}

#[derive(Serialize)]
struct LkClaims {
    iss: String,
    sub: String,
    nbf: i64,
    iat: i64,
    exp: i64,
    video: VideoGrant,
    /// Read-only for the participant: the grant omits `canUpdateOwnMetadata`.
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    attributes: HashMap<String, String>,
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn resolve_keys(lk: &LivekitConfig) -> (String, String) {
    let key = if lk.api_key.is_empty() {
        format!("telium_{}", rand_hex(16))
    } else {
        lk.api_key.clone()
    };
    let secret = if lk.api_secret.is_empty() {
        rand_hex(32)
    } else {
        lk.api_secret.clone()
    };
    (key, secret)
}

/// Mode is set on `open` so the secret never exists at 0644; an older file is repaired best-effort.
fn write_private(path: &Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = f.metadata()?.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            if let Err(e) = f.set_permissions(std::fs::Permissions::from_mode(0o600)) {
                tracing::warn!(
                    path = %path.display(),
                    mode = format!("{mode:04o}"),
                    error = %e,
                    "livekit.yaml holds the SFU's LiveKit API secret and is readable by \
                     other users on this machine; could not narrow it, please run \
                     chmod 0600 on it yourself"
                );
            }
        }
    }

    f.write_all(contents.as_bytes())
}

fn build_yaml(lk: &LivekitConfig, api_key: &str, api_secret: &str, port: u16) -> LivekitYaml {
    let mut keys = HashMap::new();
    keys.insert(api_key.to_string(), api_secret.to_string());

    let turn = if lk.turn.enabled {
        Some(TurnYaml {
            enabled: true,
            udp_port: lk.turn.udp_port,
            tls_port: lk.turn.tls_port,
            domain: lk.turn.domain.clone(),
            cert_file: lk.turn.cert_file.clone(),
            key_file: lk.turn.key_file.clone(),
        })
    } else {
        None
    };

    LivekitYaml {
        port,
        bind_addresses: vec!["0.0.0.0".to_string()],
        rtc: RtcYaml {
            port_range_start: lk.rtc.port_range_start,
            port_range_end: lk.rtc.port_range_end,
            tcp_port: lk.rtc.tcp_port,
            use_external_ip: lk.rtc.use_external_ip,
        },
        turn,
        room: RoomYaml {
            empty_timeout: lk.room.empty_timeout,
            max_participants: lk.room.max_participants,
        },
        keys,
    }
}

async fn supervise(
    _m: Arc<LivekitManager>,
    lk: LivekitConfig,
    yaml_path: std::path::PathBuf,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            break;
        }
        match launch(&lk, &yaml_path).await {
            Ok(mut child) => {
                tokio::select! {
                    status = child.wait() => {
                        match status {
                            Ok(code) => tracing::warn!(?code, "livekit-server exited; restarting"),
                            Err(e) => tracing::warn!(error = %e, "error waiting on livekit-server; restarting"),
                        }
                    }
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "failed to launch livekit-server; retrying");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    _ = shutdown.changed() => { if *shutdown.borrow() { break; } }
                }
            }
        }
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
            _ = shutdown.changed() => { if *shutdown.borrow() { break; } }
        }
    }
    tracing::info!("livekit supervisor stopped");
}

async fn launch(lk: &LivekitConfig, yaml_path: &Path) -> Result<Child> {
    let bin = resolve_binary(&lk.binary);
    let mut cmd = Command::new(&bin);
    cmd.arg("--config").arg(yaml_path);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit());
    cmd.spawn().with_context(|| format!("spawning '{}'", bin))
}

/// A bare name is also tried as `./name`, since the cwd is not on `PATH`.
fn resolve_binary(bin: &str) -> String {
    if bin.contains(std::path::MAIN_SEPARATOR) {
        return bin.to_string();
    }
    if Path::new(bin).is_file() {
        return format!(".{sep}{bin}", sep = std::path::MAIN_SEPARATOR);
    }
    bin.to_string()
}

fn rand_hex(bytes: usize) -> String {
    use rand::Rng;
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill(&mut buf[..]);
    telium_protocol::b64(&buf)
}

fn parse_port(url: &str) -> Option<u16> {
    url::Url::parse(url).ok()?.port_or_known_default()
}

fn parse_host(url: &str) -> Option<String> {
    url::Url::parse(url).ok()?.host_str().map(str::to_string)
}


impl LivekitManager {
    pub async fn control(&self, room: &str, cmd: &crate::control::ControlCommand) -> Result<()> {
        match cmd {
            crate::control::ControlCommand::Disconnect { user_id } => {
                self.remove_participant(room, user_id).await
            }
            crate::control::ControlCommand::Mute { user_id, mute } => {
                // Mute at the track level so it stays orthogonal to deafen.
                let tracks = self.participant_tracks(room, user_id).await?;
                let audio: Vec<&String> = tracks
                    .iter()
                    .filter(|t| t.kind == TrackKind::Audio)
                    .map(|t| &t.sid)
                    .collect();
                for sid in audio {
                    self.mute_track(room, user_id, sid, *mute).await?;
                }
                Ok(())
            }
            crate::control::ControlCommand::Deafen { user_id, deaf } => {
                self.set_can_subscribe(room, user_id, !*deaf).await
            }
            crate::control::ControlCommand::Subscribe { viewer, streamer, quality } => {
                let tracks = self.participant_tracks(room, streamer).await?;
                let sids: Vec<String> = tracks
                    .iter()
                    // A Watch is only the screen forward; camera and mic stay ordinary call media.
                    .filter(|t| t.is_screen_share())
                    .map(|t| t.sid.clone())
                    .collect();
                if !sids.is_empty() {
                    self.update_subscriptions(room, viewer, &sids, true).await?;
                }
                // RoomService cannot pick a simulcast layer; push the quality as a data message for the client to apply.
                self.send_data(
                    room,
                    viewer,
                    telium_protocol::WATCH_TOPIC,
                    &json!({ "streamer": streamer, "quality": quality.as_str() }),
                )
                .await
            }
            crate::control::ControlCommand::Unsubscribe { viewer, streamer } => {
                let tracks = self.participant_tracks(room, streamer).await?;
                let sids: Vec<String> = tracks
                    .iter()
                    .filter(|t| t.is_screen_share())
                    .map(|t| t.sid.clone())
                    .collect();
                if sids.is_empty() { return Ok(()); }
                self.update_subscriptions(room, viewer, &sids, false).await
            }
        }
    }

    async fn remove_participant(&self, room: &str, identity: &str) -> Result<()> {
        self.twirp("RemoveParticipant", &remove_participant_body(room, identity))
            .await
    }

    pub(crate) async fn mute_track(&self, room: &str, identity: &str, track_sid: &str, muted: bool) -> Result<()> {
        self.twirp("MutePublishedTrack", &mute_track_body(room, identity, track_sid, muted))
            .await
    }

    async fn send_data(&self, room: &str, identity: &str, topic: &str, payload: &Value) -> Result<()> {
        self.twirp("SendData", &send_data_body(room, identity, topic, payload)).await
    }

    /// A missing room yields an empty list, not an error.
    pub(crate) async fn list_participants(&self, room: &str) -> Result<Vec<ParticipantInfo>> {
        let resp = match self.twirp_raw("ListParticipants", &json!({ "room": room })).await {
            Ok(v) => v,
            Err(e) if e.to_string().contains("not_found") || e.to_string().contains("404") => {
                return Ok(Vec::new())
            }
            Err(e) => return Err(e),
        };
        let participants = resp
            .get("participants")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let identity = p.get("identity")?.as_str()?.to_string();
                        let attributes = p
                            .get("attributes")
                            .and_then(Value::as_object)
                            .map(|o| {
                                o.iter()
                                    .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let tracks = p
                            .get("tracks")
                            .and_then(Value::as_array)
                            .map(|arr| arr.iter().filter_map(parse_track).collect())
                            .unwrap_or_default();
                        Some(ParticipantInfo { identity, attributes, tracks })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(participants)
    }

    async fn set_can_subscribe(&self, room: &str, identity: &str, can_subscribe: bool) -> Result<()> {
        // UpdateParticipant replaces the permission object; read first or a mic-only participant is widened.
        let participant = self
            .twirp_raw("GetParticipant", &get_participant_body(room, identity))
            .await?;
        let permission = participant
            .get("permission")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("livekit participant has no permission object"))?;
        let body = update_permission_body(room, identity, permission, can_subscribe)?;
        self.twirp("UpdateParticipant", &body).await
    }

    async fn update_subscriptions(
        &self,
        room: &str,
        subscriber: &str,
        track_sids: &[String],
        subscribe: bool,
    ) -> Result<()> {
        self.twirp(
            "UpdateSubscriptions",
            &update_subscriptions_body(room, subscriber, track_sids, subscribe),
        )
        .await
    }

    async fn participant_tracks(&self, room: &str, identity: &str) -> Result<Vec<TrackInfo>> {
        let resp = self
            .twirp_raw("GetParticipant", &get_participant_body(room, identity))
            .await?;
        let tracks = resp
            .get("tracks")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().filter_map(parse_track).collect())
            .unwrap_or_default();
        Ok(tracks)
    }

    async fn twirp(&self, method: &str, body: &Value) -> Result<()> {
        self.twirp_raw(method, body).await.map(|_| ())
    }

    async fn twirp_raw(&self, method: &str, body: &Value) -> Result<Value> {
        let url = format!(
            "{}/twirp/livekit.RoomService/{}",
            self.url.trim_end_matches('/'),
            method
        );
        // Twirp auth is an HS256 JWT with a `roomAdmin` grant, not basic credentials.
        let room = body.get("room").and_then(Value::as_str).unwrap_or("");
        let bearer = format!("Bearer {}", self.admin_token(room)?);
        let resp = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()?
            .post(&url)
            .header("Authorization", bearer)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .with_context(|| format!("livekit {method} request failed"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow::anyhow!("livekit {method} -> {status}: {text}"));
        }
        Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
    }
}

#[derive(Debug, Clone)]
pub(crate) struct TrackInfo {
    pub sid: String,
    pub kind: TrackKind,
    pub source: String,
    pub muted: bool,
    /// Declared in AddTrack, not measured.
    pub declared_bitrate: i64,
}

impl TrackInfo {
    fn is_screen_share(&self) -> bool {
        self.source == "SCREEN_SHARE" || self.source == "SCREEN_SHARE_AUDIO"
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ParticipantInfo {
    pub identity: String,
    pub attributes: HashMap<String, String>,
    pub tracks: Vec<TrackInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrackKind {
    Audio,
    Video,
    Data,
}

fn parse_track(t: &Value) -> Option<TrackInfo> {
    let sid = t.get("sid")?.as_str()?.to_string();
    let kind = match t.get("type").and_then(Value::as_str) {
        Some("AUDIO") => TrackKind::Audio,
        Some("VIDEO") => TrackKind::Video,
        _ => TrackKind::Data,
    };
    let source = t
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN")
        .to_string();
    let muted = t.get("muted").and_then(Value::as_bool).unwrap_or(false);
    let declared_bitrate = t
        .get("layers")
        .and_then(Value::as_array)
        .map(|layers| {
            layers
                .iter()
                .filter_map(|l| l.get("bitrate"))
                .filter_map(value_as_i64)
                .sum()
        })
        .unwrap_or(0);
    Some(TrackInfo { sid, kind, source, muted, declared_bitrate })
}

/// protojson may render integers as numbers or as strings; accept both.
fn value_as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}


pub(crate) fn remove_participant_body(room: &str, identity: &str) -> Value {
    json!({ "room": room, "identity": identity })
}

pub(crate) fn mute_track_body(room: &str, identity: &str, track_sid: &str, muted: bool) -> Value {
    json!({ "room": room, "identity": identity, "trackSid": track_sid, "muted": muted })
}

pub(crate) fn update_permission_body(
    room: &str,
    identity: &str,
    mut permission: Value,
    can_subscribe: bool,
) -> Result<Value> {
    let object = permission
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("livekit permission is not an object"))?;
    object.insert("canSubscribe".into(), json!(can_subscribe));
    Ok(json!({
        "room": room,
        "identity": identity,
        "permission": permission,
    }))
}

pub(crate) fn update_subscriptions_body(
    room: &str,
    subscriber: &str,
    track_sids: &[String],
    subscribe: bool,
) -> Value {
    json!({
        "room": room,
        "identity": subscriber,
        "trackSids": track_sids,
        "subscribe": subscribe,
    })
}

pub(crate) fn get_participant_body(room: &str, identity: &str) -> Value {
    json!({ "room": room, "identity": identity })
}

/// protojson `bytes` is standard padded base64, unlike Telium's URL-safe encoding.
pub(crate) fn send_data_body(room: &str, identity: &str, topic: &str, payload: &Value) -> Value {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    json!({
        "room": room,
        "data": STANDARD.encode(payload.to_string().as_bytes()),
        "kind": "RELIABLE",
        "destinationIdentities": [identity],
        "topic": topic,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(sid: &str, kind: TrackKind, source: &str) -> TrackInfo {
        TrackInfo {
            sid: sid.into(),
            kind,
            source: source.into(),
            muted: false,
            declared_bitrate: 0,
        }
    }

    #[test]
    fn only_screen_sources_are_watch_subscriptions() {
        let video = track("screen", TrackKind::Video, "SCREEN_SHARE");
        let audio = track("screen-audio", TrackKind::Audio, "SCREEN_SHARE_AUDIO");
        let camera = track("camera", TrackKind::Video, "CAMERA");
        let microphone = track("mic", TrackKind::Audio, "MICROPHONE");
        assert!(video.is_screen_share());
        assert!(audio.is_screen_share());
        assert!(!camera.is_screen_share());
        assert!(!microphone.is_screen_share());
    }

    #[test]
    fn parse_track_sums_declared_layers_and_reads_mute() {
        let t = parse_track(&json!({
            "sid": "TR_screen", "type": "VIDEO", "source": "SCREEN_SHARE", "muted": true,
            "layers": [
                { "quality": "LOW", "bitrate": 150000 },
                { "quality": "MEDIUM", "bitrate": "600000" },
                { "quality": "HIGH", "bitrate": 2400000 },
            ],
        }))
        .unwrap();
        assert_eq!(t.kind, TrackKind::Video);
        assert!(t.muted);
        assert_eq!(t.declared_bitrate, 3_150_000);

        let bare = parse_track(&json!({ "sid": "TR_a", "type": "AUDIO", "source": "MICROPHONE" })).unwrap();
        assert!(!bare.muted);
        assert_eq!(bare.declared_bitrate, 0);
    }

    #[test]
    fn send_data_body_targets_one_identity_with_standard_base64_payload() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let b = send_data_body("telium_c1", "viewer", "telium.watch", &json!({ "streamer": "s", "quality": "low" }));
        assert_eq!(b["room"], "telium_c1");
        assert_eq!(b["kind"], "RELIABLE");
        assert_eq!(b["topic"], "telium.watch");
        assert_eq!(b["destinationIdentities"], json!(["viewer"]));
        let decoded = STANDARD.decode(b["data"].as_str().unwrap()).unwrap();
        let payload: Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(payload["streamer"], "s");
        assert_eq!(payload["quality"], "low");
    }

    #[test]
    fn connect_url_prefers_public_browser_url() {
        let manager = LivekitManager {
            url: "http://127.0.0.1:7880".into(),
            public_url: "https://livekit.example.com".into(),
            api_key: "key".into(),
            api_secret: "secret".into(),
            host: "127.0.0.1".into(),
            port: 7880,
        };
        assert_eq!(manager.connect_url(), "wss://livekit.example.com");

        let local = LivekitManager {
            public_url: String::new(),
            ..manager
        };
        assert_eq!(local.connect_url(), "ws://127.0.0.1:7880");
    }

    #[test]
    fn request_bodies_match_livekit_protojson_shape() {
        let b = remove_participant_body("telium_c1", "u1");
        assert_eq!(b["room"], "telium_c1");
        assert_eq!(b["identity"], "u1");

        let b = mute_track_body("telium_c1", "u1", "TR_abc", true);
        assert_eq!(b["room"], "telium_c1");
        assert_eq!(b["identity"], "u1");
        assert_eq!(b["trackSid"], "TR_abc");
        assert_eq!(b["muted"], true);

        let permission = json!({
            "canPublish": true,
            "canSubscribe": true,
            "canPublishSources": ["MICROPHONE"],
        });
        let b = update_permission_body("telium_c1", "u1", permission, false).unwrap();
        assert_eq!(b["permission"]["canSubscribe"], false);
        assert_eq!(b["permission"]["canPublish"], true);
        assert_eq!(b["permission"]["canPublishSources"][0], "MICROPHONE");

        let sids = vec!["TR_v1".to_string()];
        let b = update_subscriptions_body("telium_c1", "viewer", &sids, true);
        assert_eq!(b["trackSids"][0], "TR_v1");
        assert_eq!(b["subscribe"], true);

        let b = update_subscriptions_body("telium_c1", "viewer", &sids, false);
        assert_eq!(b["subscribe"], false);

        let b = get_participant_body("telium_c1", "u1");
        assert_eq!(b["room"], "telium_c1");
        assert_eq!(b["identity"], "u1");
    }

    #[test]
    fn room_names_are_injective_and_livekit_safe() {
        for ((o1, g1, c1), (o2, g2, c2)) in [
            (("a.example", "g", "c"), ("a_example", "g", "c")),
            (("a:example", "g", "c"), ("a.example", "g", "c")),
            (("a", "b_c", "d"), ("a", "b", "c_d")),
            (("127.0.0.1:7880", "g", "c"), ("127.0.0.1.7880", "g", "c")),
        ] {
            assert_ne!(room_name(o1, g1, c1), room_name(o2, g2, c2));
        }
        for raw in ["a_b", "a.b", "a/b", "\u{00e9}", "a-b", "_", "\u{0}"] {
            let e = sanitize_room_part(raw);
            assert!(e.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "{raw:?} -> {e:?}");
        }
    }
}
