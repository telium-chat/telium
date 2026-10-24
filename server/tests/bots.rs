use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use tokio_tungstenite::tungstenite::Message;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    ws: String,
    client: reqwest::Client,
    state: telium_server::AppState,
    dir: std::path::PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-bot-test-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: "test.example".into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    let state = telium_server::build_state(cfg).await.unwrap();
    telium_server::gateway::spawn_presence_flusher(state.clone());
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server {
        base: format!("http://{addr}"),
        ws: format!("ws://{addr}/gateway/v1"),
        client: reqwest::Client::new(),
        state,
        dir,
    }
}

impl Server {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let response = req.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

    async fn post_bot(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .post(format!("{}{path}", self.base))
            .header("Authorization", format!("Bot {token}"))
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

    async fn patch(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .patch(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

    async fn delete(&self, path: &str, token: &str) -> (u16, Value) {
        let response = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

    async fn user(&self, localpart: &str) -> User {
        let (status, body) = self
            .post(
                "/_telium/v1/register",
                None,
                json!({ "localpart": localpart, "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(status, 200, "register: {body}");
        let home = body["access_token"].as_str().unwrap().to_string();
        let user_id = body["user_id"].as_str().unwrap().to_string();
        let (status, guild) = self
            .post("/_telium/v1/sessions/local", Some(&home), json!({}))
            .await;
        assert_eq!(status, 200, "local guild session: {guild}");
        User {
            user_id,
            home,
            guild: guild["session_token"].as_str().unwrap().to_string(),
        }
    }
}

struct User {
    user_id: String,
    home: String,
    guild: String,
}

async fn next_dispatch(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    kind: &str,
) -> Value {
    loop {
        let raw = tokio::time::timeout(std::time::Duration::from_secs(3), socket.next())
            .await
            .expect("gateway frame timed out")
            .expect("gateway closed")
            .expect("gateway read failed");
        let Message::Text(text) = raw else { continue };
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["op"] == "DISPATCH" && frame["t"] == kind {
            return frame["d"].clone();
        }
    }
}

async fn identify_bot_with_ready(
    s: &Server,
    token: &str,
    intents: &[&str],
) -> (
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    Value,
) {
    let (mut socket, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let hello = socket.next().await.unwrap().unwrap();
    assert!(matches!(hello, Message::Text(_)));
    socket
        .send(Message::Text(
            json!({
                "op": "IDENTIFY",
                "d": { "token": token, "intents": intents, "presence": { "status": "online" } }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    loop {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else {
            continue;
        };
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["op"] == "READY" {
            return (socket, frame["d"].clone());
        }
    }
}

async fn identify_bot(
    s: &Server,
    token: &str,
    intents: &[&str],
) -> tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
> {
    identify_bot_with_ready(s, token, intents).await.0
}

#[tokio::test]
async fn bot_create_install_auth_redaction_permissions_and_uninstall() {
    let s = start().await;
    let owner = s.user("owner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Bots" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&guild_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();

    let (status, ordinary_role) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            Some(&owner.guild),
            json!({ "name": "Ordinary" }),
        )
        .await;
    assert_eq!(status, 200, "create ordinary role: {ordinary_role}");
    let ordinary_role_id = ordinary_role["id"].as_str().unwrap().to_string();
    assert_eq!(ordinary_role["position"], 1);

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Ping",
                "localpart": "pingbot",
                "allowed_intents": ["GUILD_MESSAGES", "GUILD_MEMBERS", "GUILD_STRUCTURE", "MESSAGE_CONTENT"],
                "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap().to_string();
    let bot_user_id = app["bot_user_id"].as_str().unwrap().to_string();
    let bot_token = app["token"].as_str().unwrap().to_string();

    let (status, taken) = s
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": "pingbot", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 409, "bot-reserved human username: {taken}");

    let response = s
        .client
        .get(format!("{}/_telium/v1/whoami", s.base))
        .header("Authorization", format!("Bot {bot_token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);

    let (status, too_powerful) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL", "MANAGE_MESSAGES"]
            }),
        )
        .await;
    assert_eq!(
        status, 403,
        "guild must not grant a permission outside the application's declared ceiling: {too_powerful}"
    );

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES", "GUILD_MEMBERS", "GUILD_STRUCTURE"],
                "permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");
    let bot_role_id = installed["role_id"].as_str().unwrap().to_string();

    let bot_position: i64 = sqlx::query_scalar("SELECT position FROM roles WHERE id = ?")
        .bind(&bot_role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    let ordinary_position: i64 = sqlx::query_scalar("SELECT position FROM roles WHERE id = ?")
        .bind(&ordinary_role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(bot_position, 1, "bot role should enter at the bottom of the role hierarchy");
    assert_eq!(ordinary_position, 2, "existing role should be shifted rather than tied");

    let (status, body) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/roles/{bot_role_id}"),
            &owner.guild,
            json!({ "permissions": ["VIEW_CHANNEL"] }),
        )
        .await;
    assert_eq!(status, 409, "ordinary managed-role edit escaped: {body}");

    let (status, body) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/members/{bot_user_id}"),
            &owner.guild,
            json!({ "remove_roles": [bot_role_id] }),
        )
        .await;
    assert_eq!(status, 409, "ordinary bot role detach escaped: {body}");

    let (status, body) = s
        .delete(
            &format!("/_telium/v1/guilds/{guild_id}/roles/{bot_role_id}"),
            &owner.guild,
        )
        .await;
    assert_eq!(status, 409, "ordinary managed-role delete escaped: {body}");

    let (status, body) = s
        .delete(
            &format!("/_telium/v1/guilds/{guild_id}/members/{bot_user_id}"),
            &owner.guild,
        )
        .await;
    assert_eq!(status, 409, "ordinary bot kick escaped: {body}");

    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            &bot_token,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "bot assertion: {asserted}");
    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "bot session: {session}");
    let bot_session = session["session_token"].as_str().unwrap().to_string();

    let (created_at, expires_at): (i64, i64) = sqlx::query_as(
        "SELECT created_at, expires_at FROM bot_guild_sessions \
         WHERE application_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&app_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    let configured_bot_ttl = s
        .state
        .cfg
        .sessions
        .guild_session_ttl_secs
        .min(s.state.cfg.sessions.assertion_ttl_secs)
        .max(1)
        * 1000;
    assert_eq!(
        expires_at - created_at,
        configured_bot_ttl,
        "bot guild sessions must not outlive the assertion revocation window"
    );

    let (mut messages_only, ready) =
        identify_bot_with_ready(&s, &bot_session, &["GUILD_MESSAGES"]).await;
    let ready_guild = ready["guilds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == guild_id)
        .expect("installed guild missing from READY");
    assert!(ready_guild["channels"].as_array().unwrap().is_empty());
    assert!(ready_guild["roles"].as_array().unwrap().is_empty());
    assert!(ready_guild["member_count"].is_null());
    assert_eq!(
        ready_guild["bot_allowed_intent_names"],
        json!(["GUILD_MESSAGES"]),
        "READY should expose the effective bot intents so SDKs can explain missing grants"
    );
    messages_only.close(None).await.unwrap();

    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&bot_session),
            json!({ "content": "bot says hello" }),
        )
        .await;
    assert_eq!(status, 200, "bot send: {sent}");
    assert_eq!(sent["author"], bot_user_id);

    let mut socket =
        identify_bot(&s, &bot_session, &["GUILD_MESSAGES", "MESSAGE_CONTENT"]).await;
    let (status, human_message) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner.guild),
            json!({ "content": "secret words" }),
        )
        .await;
    assert_eq!(status, 200, "human send: {human_message}");
    let dispatch = next_dispatch(&mut socket, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["content"], "");
    assert_eq!(dispatch["content_redacted"], true);

    let bot_path = format!("/_telium/v1/guilds/{guild_id}/bots/{bot_user_id}");
    let (status, patched) = s
        .patch(
            &bot_path,
            &owner.guild,
            json!({
                "intents": ["GUILD_MESSAGES", "GUILD_MEMBERS", "GUILD_STRUCTURE", "MESSAGE_CONTENT"]
            }),
        )
        .await;
    assert_eq!(status, 200, "grant message content: {patched}");

    let (status, too_powerful) = s
        .patch(
            &bot_path,
            &owner.guild,
            json!({
                "permissions": [
                    "VIEW_CHANNEL",
                    "SEND_MESSAGES",
                    "READ_MESSAGE_HISTORY",
                    "MANAGE_MESSAGES"
                ]
            }),
        )
        .await;
    assert_eq!(
        status, 403,
        "guild must not widen an installed bot beyond the app permission ceiling: {too_powerful}"
    );
    socket.close(None).await.unwrap();

    let mut no_content_socket = identify_bot(&s, &bot_session, &["GUILD_MESSAGES"]).await;
    let (status, human_message) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner.guild),
            json!({ "content": "not requested" }),
        )
        .await;
    assert_eq!(status, 200, "human send: {human_message}");
    let dispatch = next_dispatch(&mut no_content_socket, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["content"], "");
    assert_eq!(dispatch["content_redacted"], true);
    no_content_socket.close(None).await.unwrap();

    let mut socket =
        identify_bot(&s, &bot_session, &["GUILD_MESSAGES", "MESSAGE_CONTENT"]).await;
    let (status, human_message) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner.guild),
            json!({ "content": "now visible" }),
        )
        .await;
    assert_eq!(status, 200, "human send: {human_message}");
    let dispatch = next_dispatch(&mut socket, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["content"], "now visible");

    let (status, disabled) = s
        .patch(
            &format!("/_telium/v1/applications/{app_id}"),
            &owner.home,
            json!({ "install_enabled": false }),
        )
        .await;
    assert_eq!(status, 200, "disable installs: {disabled}");
    let (status, patched) = s
        .patch(
            &bot_path,
            &owner.guild,
            json!({
                "intents": ["GUILD_MESSAGES", "GUILD_MEMBERS", "GUILD_STRUCTURE"],
                "permissions": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "narrow disabled bot locally: {patched}");

    let (status, human_message) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner.guild),
            json!({ "content": "hidden again" }),
        )
        .await;
    assert_eq!(status, 200, "human send: {human_message}");
    let dispatch = next_dispatch(&mut socket, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["content"], "");
    assert_eq!(dispatch["content_redacted"], true);

    let (status, _) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&bot_session),
            json!({ "content": "should fail" }),
        )
        .await;
    assert_eq!(status, 403);

    let (status, removed) = s.delete(&bot_path, &owner.guild).await;
    assert_eq!(status, 200, "uninstall: {removed}");

    let ordinary_position: i64 = sqlx::query_scalar("SELECT position FROM roles WHERE id = ?")
        .bind(&ordinary_role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(ordinary_position, 1, "uninstall should compact the role hierarchy");
    let (status, _) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&bot_session),
            json!({ "content": "gone" }),
        )
        .await;
    assert_eq!(status, 401, "last uninstall revokes local bot sessions");
}

#[tokio::test]
async fn developer_permission_reduction_clamps_installed_role_on_fresh_session() {
    let s = start().await;
    let owner = s.user("ceilingowner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Ceiling" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Ceiling Bot",
                "localpart": "ceilingbot",
                "allowed_intents": ["GUILD_MESSAGES"],
                "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap();
    let bot_token = app["token"].as_str().unwrap();
    let bot_user_id = app["bot_user_id"].as_str().unwrap();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");

    let role_id: String = sqlx::query_scalar(
        "SELECT bot_role_id FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(bot_user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    let before: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(&role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_ne!(before as u64 & telium_server::perms::SEND_MESSAGES, 0);

    let (status, patched) = s
        .patch(
            &format!("/_telium/v1/applications/{app_id}"),
            &owner.home,
            json!({
                "default_permissions": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "reduce app permission ceiling: {patched}");

    let still_local: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(&role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_ne!(still_local as u64 & telium_server::perms::SEND_MESSAGES, 0);

    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            bot_token,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "fresh assertion: {asserted}");
    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "fresh bot session: {session}");

    let after: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(&role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(after as u64 & telium_server::perms::SEND_MESSAGES, 0);
    assert_ne!(after as u64 & telium_server::perms::VIEW_CHANNEL, 0);
    assert_ne!(after as u64 & telium_server::perms::READ_MESSAGE_HISTORY, 0);
}

#[tokio::test]
async fn expired_bot_guild_session_closes_an_open_gateway() {
    let s = start().await;
    let owner = s.user("expiryowner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Expiry" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Expiry Bot",
                "localpart": "expirybot",
                "allowed_intents": ["GUILD_MESSAGES"],
                "default_permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap();
    let bot_token = app["token"].as_str().unwrap();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");

    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            bot_token,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "assertion: {asserted}");

    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "session: {session}");
    let token = session["session_token"].as_str().unwrap();

    let soon = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 2_000;
    sqlx::query("UPDATE bot_guild_sessions SET expires_at = ? WHERE application_id = ?")
        .bind(soon)
        .bind(app_id)
        .execute(&s.state.pool)
        .await
        .unwrap();

    let mut socket = identify_bot(&s, token, &["GUILD_MESSAGES"]).await;
    let closed = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(Some(frame)))) => break frame,
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!("gateway read failed before close: {error}"),
                None => panic!("gateway ended without a close frame"),
            }
        }
    })
    .await
    .expect("expired bot gateway did not close");
    assert_eq!(u16::from(closed.code), 4004);
    assert_eq!(closed.reason.to_string(), "session expired");
}

#[tokio::test]
async fn bot_token_reset_revokes_the_previous_secret() {
    let s = start().await;
    let owner = s.user("developer").await;
    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({ "name": "Rotate", "localpart": "rotatebot" }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap();
    let old = app["token"].as_str().unwrap();
    let (status, reset) = s
        .post(
            &format!("/_telium/v1/applications/{app_id}/token/reset"),
            Some(&owner.home),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "reset: {reset}");
    let new = reset["token"].as_str().unwrap();
    assert_ne!(old, new);

    let (status, _) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            old,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 401);
    let (status, body) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            new,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "new token: {body}");
}


#[tokio::test]
async fn bot_install_preview_and_explicit_empty_capabilities() {
    let s = start().await;
    let owner = s.user("previewowner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Preview guild" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Preview Bot",
                "localpart": "previewbot",
                "description": "shows requested capabilities before install",
                "allowed_intents": ["GUILD_MESSAGES", "MESSAGE_CONTENT"],
                "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap();
    let bot_user_id = app["bot_user_id"].as_str().unwrap();

    let (status, preview) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots/preview"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example"
            }),
        )
        .await;
    assert_eq!(status, 200, "preview bot: {preview}");
    assert_eq!(preview["name"], "Preview Bot");
    assert_eq!(
        preview["allowed_intent_names"],
        json!(["GUILD_MESSAGES", "MESSAGE_CONTENT"])
    );
    assert_eq!(
        preview["default_permission_names"],
        json!(["VIEW_CHANNEL", "SEND_MESSAGES"])
    );

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": [],
                "permissions": []
            }),
        )
        .await;
    assert_eq!(status, 200, "install with empty grants: {installed}");

    let (stored_intents, role_id): (i64, String) = sqlx::query_as(
        "SELECT bot_allowed_intents, bot_role_id FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(bot_user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    let stored_permissions: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(stored_intents, 0, "explicit empty intent list must stay empty");
    assert_eq!(stored_permissions, 0, "explicit empty permission list must stay empty");

    let (status, empty_app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Empty Bot",
                "localpart": "emptybot",
                "allowed_intents": [],
                "default_permissions": []
            }),
        )
        .await;
    assert_eq!(status, 200, "create zero-capability app: {empty_app}");
    assert_eq!(empty_app["allowed_intent_names"], json!([]));
    assert_eq!(empty_app["default_permission_names"], json!([]));
}

#[tokio::test]
async fn bot_assertion_is_refused_by_the_human_session_endpoint() {
    let s = start().await;
    let owner = s.user("sessionowner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Session guild" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Session Bot",
                "localpart": "sessionbot",
                "allowed_intents": ["GUILD_MESSAGES"],
                "default_permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap().to_string();
    let bot_user_id = app["bot_user_id"].as_str().unwrap().to_string();
    let bot_token = app["token"].as_str().unwrap().to_string();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");

    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            &bot_token,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "bot assertion: {asserted}");

    let (status, escaped) = s
        .post(
            "/_telium/v1/sessions",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(
        status, 401,
        "a bot assertion must not buy a human guild session: {escaped}"
    );
    let human_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM guild_sessions WHERE user_id = ?")
            .bind(&bot_user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(human_rows, 0, "no human session row may exist for a bot");

    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "bot session: {session}");

    let (status, human) = s
        .post(
            "/_telium/v1/assertions",
            Some(&owner.home),
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "human assertion: {human}");
    let (status, human_session) = s
        .post(
            "/_telium/v1/sessions",
            None,
            json!({ "assertion": human["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "human guild session: {human_session}");
    assert_eq!(human_session["user_id"], owner.user_id);
}

#[tokio::test]
async fn bot_cannot_join_an_invite_create_a_guild_or_be_handed_ownership() {
    let s = start().await;
    let owner = s.user("escapeowner").await;

    let (status, home_guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Installed here" }),
        )
        .await;
    assert_eq!(status, 200, "create install guild: {home_guild}");
    let home_guild_id = home_guild["id"].as_str().unwrap().to_string();

    let (status, other_guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Not installed here" }),
        )
        .await;
    assert_eq!(status, 200, "create other guild: {other_guild}");
    let other_guild_id = other_guild["id"].as_str().unwrap().to_string();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Escape Bot",
                "localpart": "escapebot",
                "allowed_intents": ["GUILD_MESSAGES"],
                "default_permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap().to_string();
    let bot_user_id = app["bot_user_id"].as_str().unwrap().to_string();
    let bot_token = app["token"].as_str().unwrap().to_string();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{home_guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");

    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            &bot_token,
            json!({ "audience": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "bot assertion: {asserted}");
    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "bot session: {session}");
    let bot_session = session["session_token"].as_str().unwrap().to_string();

    let (status, invite) = s
        .post(
            &format!("/_telium/v1/guilds/{other_guild_id}/invites"),
            Some(&owner.guild),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "create invite: {invite}");
    let code = invite["code"].as_str().unwrap().to_string();

    let (status, joined) = s
        .post(
            &format!("/_telium/v1/invites/{code}/join"),
            Some(&bot_session),
            json!({}),
        )
        .await;
    assert_eq!(
        status, 409,
        "a bot must not be able to walk into a guild with an invite code: {joined}"
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(&other_guild_id)
            .bind(&bot_user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(rows, 0, "no membership row may have been written");
    let uses: i64 = sqlx::query_scalar("SELECT uses FROM invites WHERE code = ?")
        .bind(&code)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(uses, 0, "a refused join must not burn a use of the invite");

    let (status, own_guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&bot_session),
            json!({ "name": "Bot's own guild" }),
        )
        .await;
    assert_eq!(
        status, 409,
        "a bot must not be able to create a guild and own it: {own_guild}"
    );
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE owner_user_id = ?")
        .bind(&bot_user_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(owned, 0, "a bot must not own a guild");

    let (status, handed) = s
        .post(
            &format!("/_telium/v1/guilds/{home_guild_id}/transfer-ownership"),
            Some(&owner.guild),
            json!({ "user_id": bot_user_id }),
        )
        .await;
    assert_eq!(
        status, 409,
        "ownership must not be transferable to an installed bot: {handed}"
    );
    let still: String = sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
        .bind(&home_guild_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(still, owner.user_id, "ownership must not have moved");
}

#[tokio::test]
async fn reorder_roles_refuses_to_move_a_bot_managed_role() {
    let s = start().await;
    let owner = s.user("hierarchyowner").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&owner.guild),
            json!({ "name": "Hierarchy" }),
        )
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let (status, lower) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            Some(&owner.guild),
            json!({ "name": "Lower" }),
        )
        .await;
    assert_eq!(status, 200, "create lower role: {lower}");
    let lower_id = lower["id"].as_str().unwrap().to_string();

    let (status, upper) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            Some(&owner.guild),
            json!({ "name": "Upper" }),
        )
        .await;
    assert_eq!(status, 200, "create upper role: {upper}");
    let upper_id = upper["id"].as_str().unwrap().to_string();

    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": "Hierarchy Bot",
                "localpart": "hierarchybot",
                "allowed_intents": ["GUILD_MESSAGES"],
                "default_permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let app_id = app["id"].as_str().unwrap().to_string();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/bots"),
            Some(&owner.guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");
    let bot_role_id = installed["role_id"].as_str().unwrap().to_string();
    let bot_position: i64 = sqlx::query_scalar("SELECT position FROM roles WHERE id = ?")
        .bind(&bot_role_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(bot_position, 1, "the managed role enters at the bottom");

    let (status, moved) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            &owner.guild,
            json!({ "roles": [{ "id": bot_role_id, "position": 3 }] }),
        )
        .await;
    assert_eq!(
        status, 409,
        "a bot-managed role must not be repositioned by an ordinary reorder: {moved}"
    );

    let (status, mixed) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            &owner.guild,
            json!({ "roles": [
                { "id": upper_id, "position": 1 },
                { "id": bot_role_id, "position": 3 }
            ] }),
        )
        .await;
    assert_eq!(status, 409, "a mixed reorder must be refused in full: {mixed}");

    let positions: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, position FROM roles WHERE guild_id = ? ORDER BY position")
            .bind(&guild_id)
            .fetch_all(&s.state.pool)
            .await
            .unwrap();
    let at = |id: &str| positions.iter().find(|(r, _)| r == id).unwrap().1;
    assert_eq!(at(&bot_role_id), 1, "the managed role must not have moved");
    assert_eq!(at(&upper_id), 2, "an unrelated role must not have moved");
    assert_eq!(at(&lower_id), 3, "the refused move must not have landed");

    let (status, ok) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/roles"),
            &owner.guild,
            json!({ "roles": [
                { "id": upper_id, "position": 3 },
                { "id": lower_id, "position": 2 }
            ] }),
        )
        .await;
    assert_eq!(status, 200, "ordinary reorder must still work: {ok}");
}
