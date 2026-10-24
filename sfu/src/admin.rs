use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{Form, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::Engine;
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};

use crate::config::{SfuConfig, TrustedOrigin};
use crate::livekit::LivekitManager;
use crate::trust::TrustedKeys;

const SESSION_TTL: Duration = Duration::from_secs(43_200);

const LOGIN_FAILURES_BEFORE_LOCKOUT: u32 = 5;
const BASE_LOGIN_LOCKOUT: Duration = Duration::from_secs(15);
/// Short: the lockout is global, so a long one lets an attacker lock the operator out.
const MAX_LOGIN_LOCKOUT: Duration = Duration::from_secs(300);

/// Global throttle: each Argon2 check costs ~19 MiB, so verification is serialized.
#[derive(Debug, Default)]
struct LoginGate {
    consecutive_failures: u32,
    locked_until: Option<Instant>,
}

impl LoginGate {
    fn check(&mut self, now: Instant) -> Result<(), Duration> {
        match self.locked_until {
            Some(until) if until > now => Err(until - now),
            _ => {
                self.locked_until = None;
                Ok(())
            }
        }
    }

    fn note_failure(&mut self, now: Instant) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        if self.consecutive_failures >= LOGIN_FAILURES_BEFORE_LOCKOUT {
            let over = self.consecutive_failures - LOGIN_FAILURES_BEFORE_LOCKOUT;
            let lockout = BASE_LOGIN_LOCKOUT
                .saturating_mul(1u32 << over.min(16))
                .min(MAX_LOGIN_LOCKOUT);
            self.locked_until = Some(now + lockout);
        }
    }

    fn note_success(&mut self) {
        self.consecutive_failures = 0;
        self.locked_until = None;
    }
}

#[derive(Clone)]
pub struct AdminState {
    cfg: SfuConfig,
    config_path: PathBuf,
    password_path: PathBuf,
    sessions: Arc<RwLock<HashMap<String, Instant>>>,
    login_gate: Arc<Mutex<LoginGate>>,
    bootstrap_token: String,
    livekit: Arc<LivekitManager>,
    trust: Arc<RwLock<TrustedKeys>>,
}

impl AdminState {
    pub fn new(
        cfg: SfuConfig,
        config_path: PathBuf,
        livekit: Arc<LivekitManager>,
        trust: Arc<RwLock<TrustedKeys>>,
    ) -> anyhow::Result<Self> {
        let state_dir = PathBuf::from(&cfg.admin.state_dir);
        std::fs::create_dir_all(&state_dir)?;
        let password_path = state_dir.join("admin-password");
        Ok(Self {
            cfg,
            config_path,
            password_path,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            login_gate: Arc::new(Mutex::new(LoginGate::default())),
            bootstrap_token: random_token(),
            livekit,
            trust,
        })
    }

    pub fn needs_bootstrap(&self) -> bool {
        !self.password_path.exists()
    }

    pub fn bootstrap_url(&self) -> String {
        format!("http://{}/admin?token={}", display_bind(&self.cfg.admin.bind), self.bootstrap_token)
    }
}

#[derive(Deserialize)]
struct BootstrapQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct BootstrapForm {
    token: String,
    password: String,
    confirm: String,
}

#[derive(Deserialize)]
struct LoginForm {
    password: String,
}

#[derive(Deserialize)]
struct SetupForm {
    sfu_domain: String,
    livekit_domain: String,
    email: String,
    public_sfu: Option<String>,
    origin_server_name: Option<String>,
    origin_discovery_url: Option<String>,
}

#[derive(Deserialize)]
struct TrustAddForm {
    server_name: String,
}

#[derive(Deserialize)]
struct TrustRemoveForm {
    server_name: String,
}

pub fn router(state: Arc<AdminState>) -> Router {
    Router::new()
        .route("/admin", get(home))
        .route("/admin/bootstrap", post(bootstrap))
        .route("/admin/login", get(login_page).post(login))
        .route("/admin/logout", post(logout))
        .route("/admin/setup", get(setup_page).post(apply_setup))
        .route("/admin/status", get(status_page))
        .route("/admin/trust", get(trust_page).post(add_trust))
        .route("/admin/trust/remove", post(remove_trust))
        .route("/admin/restart", post(restart))
        .with_state(state)
}

async fn home(
    State(state): State<Arc<AdminState>>,
    Query(q): Query<BootstrapQuery>,
    headers: HeaderMap,
) -> Response {
    if state.needs_bootstrap() {
        if q.token.as_deref() != Some(state.bootstrap_token.as_str()) {
            return page(
                "Telium SFU setup",
                "<h1>Setup link required</h1><p>Use the one-time setup URL printed by <code>telium-sfu</code> on the server console.</p>",
            );
        }
        return bootstrap_page(&state.bootstrap_token);
    }
    if authenticated(&state, &headers).await {
        Redirect::to("/admin/status").into_response()
    } else {
        Redirect::to("/admin/login").into_response()
    }
}

async fn bootstrap(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Form(form): Form<BootstrapForm>,
) -> Response {
    if !state.needs_bootstrap() {
        return Redirect::to("/admin/login").into_response();
    }
    if form.token != state.bootstrap_token {
        return error_page(StatusCode::FORBIDDEN, "That setup link is no longer valid.");
    }
    if form.password.len() < 10 {
        return error_page(StatusCode::BAD_REQUEST, "Use an admin password with at least 10 characters.");
    }
    if form.password != form.confirm {
        return error_page(StatusCode::BAD_REQUEST, "The passwords do not match.");
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = match Argon2::default().hash_password(form.password.as_bytes(), &salt) {
        Ok(v) => v.to_string(),
        Err(_) => return error_page(StatusCode::INTERNAL_SERVER_ERROR, "Could not hash the password."),
    };
    if let Err(e) = write_secret(&state.password_path, &hash) {
        return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not save the password: {e}"));
    }
    let token = start_session(&state).await;
    redirect_with_cookie("/admin/setup", &token, &state, &headers)
}

async fn login_page() -> Response {
    page(
        "Telium SFU admin",
        r#"
        <h1>Telium SFU</h1>
        <p class="muted">Administrative dashboard</p>
        <form method="post" action="/admin/login">
          <label>Admin password<input type="password" name="password" autocomplete="current-password" required></label>
          <button type="submit">Sign in</button>
        </form>
        "#,
    )
}

async fn login(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Form(form): Form<LoginForm>,
) -> Response {
    // Serialized so a flood of wrong passwords cannot run many Argon2 hashes at once.
    let mut gate = state.login_gate.lock().await;
    if let Err(remaining) = gate.check(Instant::now()) {
        return error_page(
            StatusCode::TOO_MANY_REQUESTS,
            &format!("Too many failed sign-ins. Try again in {} seconds.", remaining.as_secs() + 1),
        );
    }

    // Argon2 is CPU-bound; keep it off the async workers.
    let path = state.password_path.clone();
    let password = form.password.clone();
    let ok = tokio::task::spawn_blocking(move || verify_password(&path, &password))
        .await
        .unwrap_or(false);

    if !ok {
        gate.note_failure(Instant::now());
        return error_page(StatusCode::UNAUTHORIZED, "Incorrect password.");
    }
    gate.note_success();
    drop(gate);

    let token = start_session(&state).await;
    redirect_with_cookie("/admin/status", &token, &state, &headers)
}

async fn logout(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if let Some(token) = session_cookie(&headers) {
        state.sessions.write().await.remove(&token);
    }
    let mut response = Redirect::to("/admin/login").into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("telium_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    response
}

async fn status_page(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    let livekit_ok = state.livekit.health().await;
    let current = SfuConfig::load(&state.config_path).unwrap_or_else(|_| state.cfg.clone());
    let public_url = if current.livekit.public_url.is_empty() {
        "<span class=\"bad\">not configured</span>".to_string()
    } else {
        format!("<code>{}</code>", esc(&current.livekit.public_url))
    };
    let html = format!(
        r#"
        <nav><strong>Telium SFU</strong><span><a href="/admin/status">Status</a> · <a href="/admin/trust">Trusted servers</a> · <a href="/admin/setup">Configure</a></span></nav>
        <h1>SFU status</h1>
        <div class="grid">
          <section><h2>LiveKit</h2><p class="{health_class}">{health}</p><p>Browser URL: {public_url}</p></section>
          <section><h2>Access</h2><p>SFU API: <code>{bind}</code></p><p>Mode: <strong>{mode}</strong></p></section>
          <section><h2>Trust</h2><p>{trust}</p><p>{origins} configured origin(s)</p></section>
        </div>
        <p><a class="button" href="/admin/setup">Configure deployment</a></p>
        <form method="post" action="/admin/restart"><button class="secondary" type="submit">Restart SFU</button></form>
        <form method="post" action="/admin/logout"><button class="secondary" type="submit">Sign out</button></form>
        "#,
        health_class = if livekit_ok { "good" } else { "bad" },
        health = if livekit_ok { "Running" } else { "Not reachable" },
        public_url = public_url,
        bind = esc(&current.bind),
        mode = if current.trust.public { "Public SFU" } else { "Private SFU" },
        trust = if current.trust.public {
            "Any federated Telium server can use this SFU."
        } else {
            "Only explicitly trusted Telium servers can use this SFU."
        },
        origins = current.trust.origins.len(),
    );
    page("Telium SFU status", &html)
}

async fn setup_page(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    let current = SfuConfig::load(&state.config_path).unwrap_or_else(|_| state.cfg.clone());
    let sfu_domain = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(':').next())
        .filter(|v| valid_domain(v))
        .unwrap_or("")
        .to_string();
    let livekit_domain = public_host(&current.livekit.public_url);
    let checked = if current.trust.public { "checked" } else { "" };
    let origin = current.trust.origins.first();
    let html = format!(
        r#"
        <nav><strong>Telium SFU</strong><span><a href="/admin/status">Status</a> · <a href="/admin/trust">Trusted servers</a> · <a href="/admin/setup">Configure</a></span></nav>
        <h1>Finish your SFU</h1>
        <p>This configures Telium, nginx, HTTPS certificates, LiveKit's public signaling URL, and the recommended firewall ports.</p>
        <form method="post" action="/admin/setup">
          <label>SFU domain
            <input name="sfu_domain" placeholder="sfu.example.com" value="{sfu_domain}" required>
            <small>DNS must point to this machine. Telium servers and browsers use this address.</small>
          </label>
          <label>LiveKit domain
            <input name="livekit_domain" placeholder="livekit.example.com" value="{livekit_domain}" required>
            <small>Used for secure LiveKit WebSocket signaling.</small>
          </label>
          <label>Let's Encrypt email
            <input type="email" name="email" placeholder="admin@example.com" required>
          </label>
          <label class="check"><input type="checkbox" name="public_sfu" {checked}> Make this a public SFU</label>
          <hr>
          <h2>Private SFU trust</h2>
          <p class="muted">Optional when public mode is enabled.</p>
          <label>Telium server name
            <input name="origin_server_name" placeholder="chat.example.com" value="{origin_name}">
          </label>
          <label>Discovery URL
            <input name="origin_discovery_url" placeholder="https://chat.example.com" value="{origin_url}">
          </label>
          <button type="submit">Configure everything</button>
        </form>
        <aside><strong>Before continuing:</strong> create DNS A/AAAA records for both domains pointing at this machine. The installer handles nginx and Certbot after that.</aside>
        "#,
        sfu_domain = esc(&sfu_domain),
        livekit_domain = esc(&livekit_domain),
        checked = checked,
        origin_name = esc(origin.map(|o| o.server_name.as_str()).unwrap_or("")),
        origin_url = esc(origin.and_then(|o| o.discovery_url.as_deref()).unwrap_or("")),
    );
    page("Configure Telium SFU", &html)
}

async fn apply_setup(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Form(form): Form<SetupForm>,
) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }

    let sfu_domain = form.sfu_domain.trim().to_ascii_lowercase();
    let livekit_domain = form.livekit_domain.trim().to_ascii_lowercase();
    if !valid_domain(&sfu_domain) || !valid_domain(&livekit_domain) {
        return error_page(StatusCode::BAD_REQUEST, "Enter valid DNS hostnames, not URLs or IP:port values.");
    }
    if !form.email.contains('@') {
        return error_page(StatusCode::BAD_REQUEST, "Enter a valid email address for Let's Encrypt.");
    }

    let mut cfg = SfuConfig::load(&state.config_path).unwrap_or_else(|_| state.cfg.clone());
    cfg.bind = "127.0.0.1:7890".into();
    cfg.livekit.url = "http://127.0.0.1:7880".into();
    cfg.livekit.public_url = format!("https://{livekit_domain}");
    cfg.livekit.rtc.use_external_ip = true;
    cfg.admin.bind = "127.0.0.1:7891".into();
    cfg.trust.discovery = true;
    cfg.trust.public = form.public_sfu.is_some();

    let origin_name = form.origin_server_name.unwrap_or_default().trim().to_string();
    let discovery_url = form.origin_discovery_url.unwrap_or_default().trim().to_string();
    if !origin_name.is_empty() {
        let entry = TrustedOrigin {
            server_name: origin_name.clone(),
            key_id: String::new(),
            public_key_b64: String::new(),
            discovery_url: if discovery_url.is_empty() { None } else { Some(discovery_url) },
        };
        if let Some(existing) = cfg.trust.origins.iter_mut().find(|o| o.server_name == origin_name) {
            *existing = entry;
        } else {
            cfg.trust.origins.push(entry);
        }
    }

    if let Err(e) = apply_proxy(&cfg.admin.helper_path, &sfu_domain, &livekit_domain, form.email.trim()).await {
        return error_page(
            StatusCode::BAD_GATEWAY,
            &format!("nginx/Certbot setup failed: {e}. Check DNS, then submit this page again."),
        );
    }

    if let Err(e) = write_config(&state.config_path, &cfg) {
        return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not save sfu.toml: {e}"));
    }

    schedule_restart(cfg.admin.helper_path.clone(), Duration::from_millis(800));

    page(
        "Telium SFU configured",
        &format!(
            r#"<h1>You're done.</h1>
            <p>HTTPS is configured and the SFU is restarting with the new settings.</p>
            <p>SFU endpoint: <code>https://{}</code></p>
            <p>LiveKit signaling: <code>wss://{}</code></p>
            <p>Dashboard: <a href="https://{}/admin">https://{}/admin</a></p>
            <p>You can now add <code>https://{}</code> as a Telium voice region.</p>"#,
            esc(&sfu_domain),
            esc(&livekit_domain),
            esc(&sfu_domain),
            esc(&sfu_domain),
            esc(&sfu_domain),
        ),
    )
}


async fn trust_page(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    let cfg = SfuConfig::load(&state.config_path).unwrap_or_else(|_| state.cfg.clone());
    let mut rows = String::new();
    for origin in &cfg.trust.origins {
        rows.push_str(&format!(
            r#"<tr><td><strong>{}</strong></td><td><code>{}</code></td><td>
            <form class="inline" method="post" action="/admin/trust/remove">
              <input type="hidden" name="server_name" value="{}">
              <button class="danger" type="submit">Remove</button>
            </form></td></tr>"#,
            esc(&origin.server_name),
            esc(origin.discovery_url.as_deref().unwrap_or("pinned key")),
            esc(&origin.server_name),
        ));
    }
    if rows.is_empty() {
        rows.push_str(r#"<tr><td colspan="3" class="muted">No servers are whitelisted yet.</td></tr>"#);
    }
    let public_note = if cfg.trust.public {
        r#"<aside><strong>Public mode is enabled.</strong> Unknown Telium servers can already discover themselves automatically. Entries below are still persisted and refreshed explicitly.</aside>"#
    } else {
        r#"<aside>Private mode is enabled. Only servers listed here can create new SFU sessions or send control commands.</aside>"#
    };
    let html = format!(
        r#"
        <nav><strong>Telium SFU</strong><span><a href="/admin/status">Status</a> · <a href="/admin/trust">Trusted servers</a> · <a href="/admin/setup">Configure</a></span></nav>
        <h1>Trusted servers</h1>
        <p>Add a Telium homeserver while the SFU is running. Existing calls are not restarted.</p>
        {public_note}
        <section>
          <h2>Add server</h2>
          <form method="post" action="/admin/trust">
            <label>Server name
              <input name="server_name" placeholder="chat.example.com" required>
              <small>Enter the Telium server_name only. The SFU will resolve federation discovery and verify its signing keys automatically.</small>
            </label>
            <button type="submit">Discover &amp; whitelist</button>
          </form>
        </section>
        <section>
          <h2>Whitelist</h2>
          <table><thead><tr><th>Server</th><th>Discovered API</th><th></th></tr></thead><tbody>{rows}</tbody></table>
        </section>
        "#,
        public_note = public_note,
        rows = rows,
    );
    page("Trusted Telium servers", &html)
}

async fn add_trust(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Form(form): Form<TrustAddForm>,
) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    let server_name = form.server_name.trim().to_ascii_lowercase();
    if !valid_domain(&server_name) {
        return error_page(StatusCode::BAD_REQUEST, "Enter a valid Telium server_name such as chat.example.com.");
    }

    let mut cfg = match SfuConfig::load(&state.config_path) {
        Ok(cfg) => cfg,
        Err(e) => return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not read sfu.toml: {e}")),
    };
    if cfg.trust.origins.iter().any(|o| o.server_name == server_name) {
        return error_page(StatusCode::CONFLICT, "That server is already whitelisted.");
    }

    let mut probe = TrustedKeys::from_config(&cfg.trust);
    // Operator-typed, so configuration rather than an unauthenticated claim.
    let Some(base) = probe
        .discover_origin(&server_name, crate::fetch::AddressPolicy::OperatorConfigured)
        .await
    else {
        return error_page(
            StatusCode::BAD_GATEWAY,
            "Could not discover and verify that Telium server. Check its server_name, .well-known discovery, and /_telium/v1/keys endpoint.",
        );
    };

    cfg.trust.origins.push(TrustedOrigin {
        server_name: server_name.clone(),
        key_id: String::new(),
        public_key_b64: String::new(),
        discovery_url: Some(base),
    });
    if let Err(e) = write_config(&state.config_path, &cfg) {
        return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not save whitelist: {e}"));
    }
    // Keep the verified key so a second network failure cannot lose a successful discovery.
    probe.refresh_discovery(&cfg.trust).await;
    *state.trust.write().await = probe;

    Redirect::to("/admin/trust").into_response()
}

async fn remove_trust(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Form(form): Form<TrustRemoveForm>,
) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    let server_name = form.server_name.trim().to_ascii_lowercase();
    let mut cfg = match SfuConfig::load(&state.config_path) {
        Ok(cfg) => cfg,
        Err(e) => return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not read sfu.toml: {e}")),
    };
    let before = cfg.trust.origins.len();
    cfg.trust.origins.retain(|o| o.server_name != server_name);
    if cfg.trust.origins.len() == before {
        return error_page(StatusCode::NOT_FOUND, "That server is not in the whitelist.");
    }
    if let Err(e) = write_config(&state.config_path, &cfg) {
        return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Could not save whitelist: {e}"));
    }
    if let Err(e) = reload_runtime_trust(&state, &cfg).await {
        return error_page(StatusCode::INTERNAL_SERVER_ERROR, &format!("Saved whitelist but could not activate it: {e}"));
    }

    Redirect::to("/admin/trust").into_response()
}

async fn reload_runtime_trust(state: &AdminState, cfg: &SfuConfig) -> anyhow::Result<()> {
    let mut next = TrustedKeys::from_config(&cfg.trust);
    next.refresh_discovery(&cfg.trust).await;
    *state.trust.write().await = next;
    Ok(())
}

async fn restart(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if !authenticated(&state, &headers).await {
        return Redirect::to("/admin/login").into_response();
    }
    schedule_restart(state.cfg.admin.helper_path.clone(), Duration::from_millis(500));
    page("Restarting", "<h1>Restarting SFU…</h1><p>The service will be back in a moment.</p>")
}

fn schedule_restart(helper: String, delay: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(delay).await;
        let _ = tokio::process::Command::new("sudo")
            .arg("-n")
            .arg(helper)
            .arg("restart")
            .status()
            .await;
    });
}

async fn apply_proxy(helper: &str, sfu_domain: &str, livekit_domain: &str, email: &str) -> anyhow::Result<()> {
    let output = tokio::process::Command::new("sudo")
        .arg("-n")
        .arg(helper)
        .arg("proxy")
        .arg(sfu_domain)
        .arg(livekit_domain)
        .arg(email)
        .output()
        .await?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow::bail!("{}", stderr.trim());
}

async fn start_session(state: &AdminState) -> String {
    let token = random_token();
    let now = Instant::now();
    let mut guard = state.sessions.write().await;
    guard.retain(|_, expires| *expires > now);
    guard.insert(token.clone(), now + SESSION_TTL);
    token
}

async fn authenticated(state: &AdminState, headers: &HeaderMap) -> bool {
    let Some(token) = session_cookie(headers) else { return false; };
    // Checked here because only cooperating browsers honour `Max-Age`.
    match state.sessions.read().await.get(&token) {
        Some(expires) => *expires > Instant::now(),
        None => false,
    }
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').map(str::trim).find_map(|part| {
        part.strip_prefix("telium_admin=").map(str::to_string)
    })
}

fn redirect_with_cookie(
    to: &str,
    token: &str,
    state: &AdminState,
    headers: &HeaderMap,
) -> Response {
    let mut response = Redirect::to(to).into_response();
    let secure = if should_mark_cookie_secure(&state.cfg.admin.bind, headers) {
        "; Secure"
    } else {
        ""
    };
    if let Ok(value) = HeaderValue::from_str(&format!(
        "telium_admin={token}; Path=/admin; HttpOnly; SameSite=Strict{secure}; Max-Age=43200"
    )) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// `Secure` unless X-Forwarded-Proto is present (trusted proxy) or the bind is loopback.
fn should_mark_cookie_secure(bind: &str, headers: &HeaderMap) -> bool {
    if let Some(proto) = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()) {
        return proto.split(',').next().map(str::trim).is_some_and(|p| p.eq_ignore_ascii_case("https"));
    }
    !bind_is_loopback(bind)
}

fn bind_is_loopback(bind: &str) -> bool {
    let host = match bind.rsplit_once(':') {
        Some((h, _)) => h,
        None => bind,
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

fn verify_password(path: &Path, password: &str) -> bool {
    let Ok(encoded) = std::fs::read_to_string(path) else { return false; };
    let Ok(hash) = PasswordHash::new(encoded.trim()) else { return false; };
    Argon2::default().verify_password(password.as_bytes(), &hash).is_ok()
}

fn write_secret(path: &Path, value: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(value.as_bytes())?;
        return Ok(());
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, value)
    }
}

fn write_config(path: &Path, cfg: &SfuConfig) -> anyhow::Result<()> {
    let text = toml::to_string_pretty(cfg)?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn valid_domain(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 253
        && value.contains('.')
        && !value.starts_with('.')
        && !value.ends_with('.')
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
}

fn display_bind(bind: &str) -> String {
    if let Some(port) = bind.rsplit(':').next() {
        if bind.starts_with("0.0.0.0:") || bind.starts_with("127.0.0.1:") {
            return format!("SERVER_IP:{port}");
        }
    }
    bind.to_string()
}

fn public_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn esc(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn bootstrap_page(token: &str) -> Response {
    page(
        "Create Telium SFU admin",
        &format!(
            r#"
            <h1>Create your admin password</h1>
            <p>This one-time link came from the SFU console. After this, the dashboard requires your password.</p>
            <form method="post" action="/admin/bootstrap">
              <input type="hidden" name="token" value="{}">
              <label>Password<input type="password" name="password" minlength="10" autocomplete="new-password" required></label>
              <label>Confirm password<input type="password" name="confirm" minlength="10" autocomplete="new-password" required></label>
              <button type="submit">Create admin account</button>
            </form>
            "#,
            esc(token)
        ),
    )
}

fn error_page(status: StatusCode, message: &str) -> Response {
    (
        status,
        page_body(
            "Telium SFU",
            &format!(
                "<h1>Couldn't continue</h1><p>{}</p><p><a href=\"javascript:history.back()\">Go back</a></p>",
                esc(message)
            ),
        ),
    )
        .into_response()
}

fn page(title: &str, body: &str) -> Response {
    Html(page_body(title, body)).into_response()
}

fn page_body(title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{}</title>
<style>
:root{{color-scheme:dark;background:#0c0d10;color:#f4f4f5;font-family:Inter,ui-sans-serif,system-ui,sans-serif}}
*{{box-sizing:border-box}}body{{max-width:920px;margin:0 auto;padding:48px 24px;line-height:1.5}}
h1{{font-size:2.2rem;margin:.3em 0}}h2{{font-size:1.05rem}}a{{color:#c4b5fd}}
nav{{display:flex;justify-content:space-between;align-items:center;margin-bottom:36px;padding-bottom:18px;border-bottom:1px solid #27272a}}
form{{max-width:620px;margin:24px 0}}form.inline{{display:inline;margin:0}}label{{display:block;margin:18px 0;font-weight:650}}
input{{display:block;width:100%;margin-top:7px;padding:12px 14px;border-radius:9px;border:1px solid #3f3f46;background:#18181b;color:#fff;font:inherit}}
label.check{{display:flex;gap:10px;align-items:center}}label.check input{{width:auto;margin:0}}
small,.muted{{display:block;color:#a1a1aa;font-weight:400;margin-top:5px}}
button,.button{{display:inline-block;border:0;border-radius:9px;padding:11px 16px;background:#7c3aed;color:white;font:inherit;font-weight:750;text-decoration:none;cursor:pointer}}
button.secondary{{background:#27272a;margin-top:8px}}button.danger{{background:#7f1d1d;padding:7px 10px}}table{{width:100%;border-collapse:collapse}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #292a30;vertical-align:middle}}hr{{border:0;border-top:1px solid #27272a;margin:32px 0}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}}
section,aside{{background:#15161a;border:1px solid #292a30;border-radius:13px;padding:18px;margin:18px 0}}
.good{{color:#86efac;font-weight:750}}.bad{{color:#fca5a5;font-weight:750}}code{{background:#202126;padding:.15em .4em;border-radius:5px}}
</style>
</head>
<body>{}</body>
</html>"#,
        esc(title),
        body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_gate_locks_out_boundedly_and_clears_on_success() {
        let (mut gate, now) = (LoginGate::default(), Instant::now());
        for _ in 0..(LOGIN_FAILURES_BEFORE_LOCKOUT - 1) {
            gate.note_failure(now);
        }
        assert!(gate.check(now).is_ok(), "a few typos must not lock the operator out");
        for _ in 0..200 {
            gate.note_failure(now);
        }
        let remaining = gate.check(now).expect_err("locked after repeated failures");
        assert!(remaining > Duration::ZERO && remaining <= MAX_LOGIN_LOCKOUT);
        assert!(gate.check(now + MAX_LOGIN_LOCKOUT + Duration::from_secs(1)).is_ok());
        gate.note_success();
        assert!(gate.check(now).is_ok());
    }

    #[test]
    fn admin_cookie_secure_flag() {
        let proto = |v: &'static str| {
            let mut h = HeaderMap::new();
            h.insert("x-forwarded-proto", HeaderValue::from_static(v));
            h
        };
        let none = HeaderMap::new();
        for (bind, headers, secure) in [
            ("127.0.0.1:7891", proto("https"), true),
            ("127.0.0.1:7891", proto("https, http"), true),
            ("0.0.0.0:7891", none.clone(), true),
            ("198.51.100.7:7891", none.clone(), true),
            ("127.0.0.1:7891", none.clone(), false),
            ("localhost:7891", none.clone(), false),
            ("[::1]:7891", none.clone(), false),
            ("127.0.0.1:7891", proto("http"), false),
        ] {
            assert_eq!(should_mark_cookie_secure(bind, &headers), secure, "{bind} {headers:?}");
        }
    }
}
