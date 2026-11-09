
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
    pub updates: Updates,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct LimitsConfig {
    pub max_bitrate: i64,
    pub enforce: bool,
    pub poll_interval_secs: u64,
    /// Admission ceiling: at most this many concurrent rooms (0 = unlimited).
    /// A relay nearing this refuses new joins; existing calls are untouched.
    /// Pick it to match the uplink: a room of n voice participants costs
    /// roughly (n-1) x 40 kbps of egress, video far more.
    pub max_rooms: u32,
    /// At most this many participants across all rooms (0 = unlimited).
    pub max_participants: u32,
    /// Estimated transfer budget in bytes over `transfer_period_days`; 0 = no
    /// budget. The estimate is deliberately conservative (it assumes every
    /// declared video layer flows) — a relay under a hard traffic cap stops
    /// taking NEW calls as it nears the budget rather than exceeding it.
    pub transfer_budget_bytes: i64,
    pub transfer_period_days: u32,
    /// Percentage of the estimated transfer allowance at which new calls stop.
    /// Keep headroom for calls already in progress (1..=100; default 80).
    pub transfer_stop_percent: u32,
    /// Guild servers this relay refuses, by `server_name` (the origin a join
    /// token is signed by). Blocked at admission; rooms already in progress
    /// finish naturally.
    pub blocked_origins: Vec<String>,
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

/// Self-update check: GET one public manifest (and its detached signature)
/// over HTTPS with a bare User-Agent; `check = false` fetches nothing. The
/// check only *reports* — the actual apply is `deploy/update-sfu-native.sh`
/// or `deploy/update-sfu.sh` on their systemd timers, which ask this binary
/// what to do via `telium-sfu updates check`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Updates {
    pub check: bool,
    /// Release list URL (JSON written by CI into `deploy/sfu-releases.json`).
    pub manifest_url: String,
    /// Check interval, retry delay and per-fetch timeout.
    pub check_interval_secs: i64,
    pub retry_secs: i64,
    pub timeout_secs: u64,
    /// Lag before warning, and before urgent. Security releases are urgent immediately.
    pub stale_after_days: i64,
    pub urgent_after_days: i64,
    /// Ed25519 manifest-signing key, url-safe base64; empty means unchecked. Never compiled in.
    pub manifest_public_key: String,
    /// Where the detached signature lives. Empty means `manifest_url` + `.sig`.
    pub manifest_signature_url: String,
    /// How long a drain (SIGUSR1: refuse new joins, let calls finish) lasts
    /// before the relay resumes accepting on its own. The update script waits
    /// within this ceiling; auto-expiry is what stops a crashed updater from
    /// leaving the relay refusing joins forever.
    pub drain_max_secs: u64,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            check: true,
            manifest_url:
                "https://raw.githubusercontent.com/telium-chat/telium/main/deploy/sfu-releases.json"
                    .into(),
            check_interval_secs: 6 * 60 * 60,
            retry_secs: 30 * 60,
            timeout_secs: 10,
            stale_after_days: 14,
            urgent_after_days: 45,
            // Official release artifacts compile in the publisher key. Hand
            // builds with no such key retain the explicit opt-in behavior.
            manifest_public_key: option_env!("TELIUM_RELEASE_PUBLIC_KEY").unwrap_or("").into(),
            manifest_signature_url: String::new(),
            drain_max_secs: 900,
        }
    }
}

impl Updates {
    /// Scoped validation for this section. Called on `serve` startup and by
    /// `telium-sfu --config X check`, which is how the updater audits the
    /// operator's config with the *staged* binary before anything restarts.
    pub fn validate(&self) -> anyhow::Result<()> {
        if self.drain_max_secs < 30 || self.drain_max_secs > 86_400 {
            anyhow::bail!(
                "updates.drain_max_secs must be between 30 and 86400 (it is how long a drain \
                 for an update can hold new joins out before the relay resumes on its own; \
                 shorter never gets anywhere, longer outlives the updater that asked)"
            );
        }
        if self.check {
            if self.stale_after_days < 1 || self.urgent_after_days < self.stale_after_days {
                anyhow::bail!(
                    "updates.stale_after_days must be at least 1 and updates.urgent_after_days \
                     must not be smaller than it (they are the two steps of one escalation, and \
                     a louder threshold that arrives first is not a step)"
                );
            }
            if !(self.manifest_url.starts_with("https://") || self.manifest_url.starts_with("http://")) {
                anyhow::bail!(
                    "updates.manifest_url must be an https URL, or set updates.check = false to \
                     turn the check off deliberately"
                );
            }
            // Malformed key would make every signature check look like a forgery.
            if !self.manifest_public_key.is_empty() {
                // Decoded with the verifier's own function so we can't accept a key it rejects.
                let decoded = telium_protocol::unb64(self.manifest_public_key.trim())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "updates.manifest_public_key is set but is not url-safe unpadded \
                             base64, which is the form the project publishes its release key in. \
                             If what you pasted ends in `=` or contains `+` or `/`, it is the other \
                             base64 alphabet and this relay will never decode it. Leave the key \
                             empty to check release metadata against nothing but its transport."
                        )
                    })?;
                if decoded.len() != 32 {
                    anyhow::bail!(
                        "updates.manifest_public_key decodes to {} bytes and an Ed25519 public key \
                         is 32. A private key, a signature or a fingerprint pasted here would fail \
                         every signature check for the life of the deployment while looking \
                         configured.",
                        decoded.len()
                    );
                }
            }
        }
        Ok(())
    }
}

impl Default for SfuConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:7890".into(),
            livekit: LivekitConfig::default(),
            trust: TrustConfig::default(),
            admin: AdminConfig::default(),
            limits: LimitsConfig::default(),
            updates: Updates::default(),
        }
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_bitrate: 8_000_000,
            enforce: true,
            poll_interval_secs: 15,
            max_rooms: 0,
            max_participants: 0,
            transfer_budget_bytes: 0,
            transfer_period_days: 30,
            transfer_stop_percent: 80,
            blocked_origins: Vec::new(),
        }
    }
}

impl LimitsConfig {
    pub fn admission_budget_bytes(&self) -> i64 {
        self.transfer_budget_bytes.saturating_mul(self.transfer_stop_percent.clamp(1, 100) as i64) / 100
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        if !(1..=100).contains(&self.transfer_stop_percent) {
            anyhow::bail!("limits.transfer_stop_percent must be between 1 and 100");
        }
        if self.transfer_budget_bytes < 0 {
            anyhow::bail!("limits.transfer_budget_bytes cannot be negative (0 disables the budget)");
        }
        if self.transfer_period_days == 0 {
            anyhow::bail!("limits.transfer_period_days must be at least 1");
        }
        Ok(())
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
