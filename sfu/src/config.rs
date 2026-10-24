
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct SfuConfig {
    pub bind: String,
    pub livekit: LivekitConfig,
    pub trust: TrustConfig,
    pub admin: AdminConfig,
    pub limits: LimitsConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct LimitsConfig {
    pub max_bitrate: i64,
    pub enforce: bool,
    pub poll_interval_secs: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct LivekitConfig {
    pub mode: LivekitMode,
    pub url: String,
    pub public_url: String,
    pub api_key: String,
    pub api_secret: String,
    pub binary: String,
    pub config_dir: String,
    pub rtc: RtcConfig,
    pub turn: TurnConfig,
    pub room: RoomConfig,
}

/// No derived `Debug`: `api_secret` would leak into logs.
impl std::fmt::Debug for LivekitConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LivekitConfig")
            .field("mode", &self.mode)
            .field("url", &self.url)
            .field("public_url", &self.public_url)
            // Not a secret: useless alone, appears in LiveKit's own logs, and operators need it to tell which credential is in use.
            .field("api_key", &self.api_key)
            .field(
                "api_secret",
                &if self.api_secret.is_empty() { "<unset>" } else { "<set>" },
            )
            .field("binary", &self.binary)
            .field("config_dir", &self.config_dir)
            .field("rtc", &self.rtc)
            .field("turn", &self.turn)
            .field("room", &self.room)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum LivekitMode {
    #[serde(alias = "spawn")]
    Spawn,
    #[serde(alias = "external")]
    External,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct RtcConfig {
    pub port_range_start: u16,
    pub port_range_end: u16,
    pub tcp_port: u16,
    pub use_external_ip: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct TurnConfig {
    pub enabled: bool,
    pub udp_port: u16,
    pub tls_port: Option<u16>,
    pub domain: Option<String>,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct RoomConfig {
    pub empty_timeout: u32,
    pub max_participants: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct TrustConfig {
    pub discovery: bool,
    pub cache_ttl_secs: i64,
    pub public: bool,
    /// Re-opens an SSRF hole; must stay false on any internet-reachable SFU.
    pub allow_insecure_discovery: bool,
    pub origins: Vec<TrustedOrigin>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct TrustedOrigin {
    pub server_name: String,
    pub key_id: String,
    pub public_key_b64: String,
    pub discovery_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct AdminConfig {
    pub enabled: bool,
    pub bind: String,
    pub state_dir: String,
    pub helper_path: String,
}

impl Default for SfuConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:7890".into(),
            livekit: LivekitConfig::default(),
            trust: TrustConfig::default(),
            admin: AdminConfig::default(),
            limits: LimitsConfig::default(),
        }
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self { max_bitrate: 8_000_000, enforce: true, poll_interval_secs: 15 }
    }
}

impl Default for LivekitMode {
    fn default() -> Self {
        LivekitMode::Spawn
    }
}

impl Default for LivekitConfig {
    fn default() -> Self {
        Self {
            mode: LivekitMode::default(),
            url: "http://127.0.0.1:7880".into(),
            public_url: String::new(),
            api_key: String::new(),
            api_secret: String::new(),
            binary: "livekit-server".into(),
            config_dir: ".".into(),
            rtc: RtcConfig::default(),
            turn: TurnConfig::default(),
            room: RoomConfig::default(),
        }
    }
}

impl Default for RtcConfig {
    fn default() -> Self {
        Self {
            port_range_start: 50000,
            port_range_end: 60000,
            tcp_port: 7881,
            use_external_ip: false,
        }
    }
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            udp_port: 3478,
            tls_port: None,
            domain: None,
            cert_file: None,
            key_file: None,
        }
    }
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self { empty_timeout: 300, max_participants: 0 }
    }
}

impl Default for TrustConfig {
    fn default() -> Self {
        Self {
            discovery: true,
            cache_ttl_secs: 86400,
            public: false,
            allow_insecure_discovery: false,
            origins: Vec::new(),
        }
    }
}

impl Default for AdminConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bind: "127.0.0.1:7891".into(),
            state_dir: "./state".into(),
            helper_path: "/usr/local/libexec/telium-sfu-admin-helper".into(),
        }
    }
}

impl SfuConfig {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
        let cfg: SfuConfig = toml::from_str(&text)?;
        Ok(cfg)
    }
}
