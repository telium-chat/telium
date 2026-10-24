use axum::extract::FromRequestParts;
use axum::http::{header, Method, Request};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{auth::BotAuth, config::Config, error::{ApiError, Coded}, util::hash_token, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TestState {
    state: AppState,
    dir: std::path::PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl std::ops::Deref for TestState {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

async fn state() -> TestState {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "telium-bot-ratelimit-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: "test.example".into(),
        public_base_url: "http://test.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.rate_limit.enabled = true;
    cfg.rate_limit.write_burst = 1;
    cfg.rate_limit.write_per_sec = 0.001;
    let state = telium_server::build_state(cfg).await.unwrap();
    TestState { state, dir }
}

async fn application(s: &AppState, id: &str, localpart: &str, token: &str) {
    sqlx::query(
        "INSERT OR IGNORE INTO accounts \
         (user_id, localpart, domain, password_hash, created_at) \
         VALUES ('@developer:test.example', 'developer', 'test.example', 'unused', 1)",
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let user_id = format!("@{localpart}:test.example");
    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES (?, '@developer:test.example', ?, ?, 1, 1)",
    )
    .bind(id)
    .bind(localpart)
    .bind(&user_id)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_identities \
         (user_id, application_id, localpart, domain, created_at) \
         VALUES (?, ?, ?, 'test.example', 1)",
    )
    .bind(&user_id)
    .bind(id)
    .bind(localpart)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_credentials (id, application_id, token_hash, created_at) \
         VALUES (?, ?, ?, 1)",
    )
    .bind(format!("credential-{id}"))
    .bind(id)
    .bind(hash_token(token))
    .execute(&s.pool)
    .await
    .unwrap();
}

async fn authenticate(s: &AppState, token: &str, method: Method) -> Result<BotAuth, Coded> {
    let request = Request::builder()
        .method(method)
        .header(header::AUTHORIZATION, format!("Bot {token}"))
        .body(())
        .unwrap();
    let (mut parts, _) = request.into_parts();
    BotAuth::from_request_parts(&mut parts, s).await
}

#[tokio::test]
async fn rotating_a_bot_secret_does_not_reset_the_application_bucket() {
    let s = state().await;
    let app = "01BOTRATELIMIT0000000000001";
    let old = "telium_bot_old_secret";
    let new = "telium_bot_new_secret";
    application(&s, app, "ratelimitbot", old).await;

    let first = authenticate(&s, old, Method::POST).await.unwrap();
    assert_eq!(first.application_id, app);

    let mut tx = s.pool.begin().await.unwrap();
    sqlx::query(
        "UPDATE bot_credentials SET revoked_at = 2 \
         WHERE application_id = ? AND revoked_at IS NULL",
    )
    .bind(app)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_credentials (id, application_id, token_hash, created_at) \
         VALUES ('credential-rotated', ?, ?, 2)",
    )
    .bind(app)
    .bind(hash_token(new))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let rotated = authenticate(&s, new, Method::POST).await;
    assert!(
        matches!(rotated.as_ref().err().map(Coded::error), Some(ApiError::RateLimited(_))),
        "a new secret must not buy the same application a fresh bucket: {rotated:?}"
    );

    application(
        &s,
        "01BOTRATELIMIT0000000000002",
        "anotherbot",
        "telium_bot_another_secret",
    )
    .await;
    assert!(authenticate(&s, "telium_bot_another_secret", Method::POST).await.is_ok());
}

#[tokio::test]
async fn bot_installation_reads_do_not_spend_the_application_write_bucket() {
    let s = state().await;
    let app = "01BOTRATELIMIT0000000000003";
    let token = "telium_bot_polling_secret";
    application(&s, app, "pollingbot", token).await;

    let read = authenticate(&s, token, Method::GET).await;
    assert!(read.is_ok(), "bot read should authenticate: {read:?}");

    let write = authenticate(&s, token, Method::POST).await;
    assert!(
        write.is_ok(),
        "a preceding bot read must not spend the application's write bucket: {write:?}"
    );
}

use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

struct RestServer {
    base: String,
    ws: String,
    client: reqwest::Client,
    state: AppState,
    dir: std::path::PathBuf,
}

impl Drop for RestServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl RestServer {
    async fn start() -> RestServer {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("telium-bot-content-{}-{n}", std::process::id()));
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
        let app = telium_server::routes::router(state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        RestServer {
            base: format!("http://{addr}"),
            ws: format!("ws://{addr}/gateway/v1"),
            client: reqwest::Client::new(),
            state,
            dir,
        }
    }

    async fn get(&self, path: &str, token: &str) -> (u16, Value) {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

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

    async fn put(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let response = self
            .client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
    }

    async fn human(&self, localpart: &str) -> (String, String, String) {
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
        assert_eq!(status, 200, "local session: {guild}");
        (user_id, home, guild["session_token"].as_str().unwrap().to_string())
    }
}

async fn install_bot(
    s: &RestServer,
    owner_home: &str,
    owner_guild: &str,
    guild_id: &str,
    localpart: &str,
    granted: &[&str],
) -> (String, String) {
    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(owner_home),
            json!({
                "name": localpart,
                "localpart": localpart,
                "allowed_intents": ["GUILD_MESSAGES", "GUILD_STRUCTURE", "MESSAGE_CONTENT"],
                "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
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
            Some(owner_guild),
            json!({
                "application_id": app_id,
                "application_origin": "test.example",
                "intents": granted,
                "permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
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
    assert_eq!(status, 200, "assertion: {asserted}");
    let (status, session) = s
        .post(
            "/_telium/v1/bots/session",
            None,
            json!({ "assertion": asserted["assertion"] }),
        )
        .await;
    assert_eq!(status, 200, "bot session: {session}");
    (bot_user_id, session["session_token"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn rest_reads_redact_message_content_for_a_bot_without_the_grant() {
    let s = RestServer::start().await;
    let (_, owner_home, owner_guild) = s.human("contentowner").await;

    let (status, guild) = s
        .post("/_telium/v1/guilds", Some(&owner_guild), json!({ "name": "Privacy" }))
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&guild_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();

    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner_guild),
            json!({
                "content": "the redundancy list is attached",
                "attachments": [{
                    "origin": "test.example",
                    "hash": "0000000000000000000000000000000000000000000000000000000000000000",
                    "filename": "q3-redundancies-final.pdf",
                    "mime": "application/pdf",
                    "size": 4096
                }],
                "sticker": { "id": "01STICKER", "name": "shush", "origin": "test.example" },
                "author_signature": "sig-over-the-body"
            }),
        )
        .await;
    assert_eq!(status, 200, "human send: {sent}");
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, pinned) = s
        .put(
            &format!("/_telium/v1/channels/{channel_id}/pins/{message_id}"),
            &owner_guild,
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "pin: {pinned}");

    let (_, bot_session) = install_bot(
        &s,
        &owner_home,
        &owner_guild,
        &guild_id,
        "quietbot",
        &["GUILD_MESSAGES", "GUILD_STRUCTURE"],
    )
    .await;

    let (status, history) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/messages"), &bot_session)
        .await;
    assert_eq!(status, 200, "bot history: {history}");
    let message = &history["messages"][0];
    assert_eq!(message["id"], message_id.as_str(), "the bot still sees that a message exists");
    assert_eq!(message["content"], "", "history handed the body to an ungranted bot: {history}");
    assert_eq!(message["content_redacted"], true, "the SDK needs to be told why: {history}");
    assert_eq!(message["attachments"], json!([]), "attachment references survived: {history}");
    assert!(message["sticker"].is_null(), "sticker survived redaction: {history}");
    assert!(
        message["author_signature"].is_null(),
        "a signature over the body is a confirmation oracle for it: {history}"
    );
    assert_eq!(message["author"], sent["author"], "redaction must not take the author too");
    assert!(message["created_at"].is_i64());

    let (status, pins) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/pins"), &bot_session)
        .await;
    assert_eq!(status, 200, "bot pins: {pins}");
    assert_eq!(pins["pins"][0]["content"], "", "pins handed over the body: {pins}");
    assert_eq!(pins["pins"][0]["content_redacted"], true);
    assert_eq!(pins["pins"][0]["attachments"], json!([]));

    let (status, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=redundancy"), &bot_session)
        .await;
    assert_eq!(status, 200, "bot search: {found}");
    assert_eq!(found["count"], 1, "the bot may still learn the message exists: {found}");
    assert_eq!(found["results"][0]["content"], "", "search handed over the body: {found}");
    assert_eq!(found["results"][0]["content_redacted"], true);
    assert_eq!(found["results"][0]["attachments"], json!([]));

    let (mut socket, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _ = socket.next().await.unwrap().unwrap();
    use futures_util::SinkExt;
    socket
        .send(Message::Text(
            json!({
                "op": "IDENTIFY",
                "d": { "token": bot_session, "intents": ["GUILD_MESSAGES", "MESSAGE_CONTENT"] }
            })
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    loop {
        let Message::Text(text) = socket.next().await.unwrap().unwrap() else { continue };
        if serde_json::from_str::<Value>(&text).unwrap()["op"] == "READY" {
            break;
        }
    }
    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner_guild),
            json!({
                "content": "said out loud",
                "attachments": [{
                    "origin": "test.example",
                    "hash": "1111111111111111111111111111111111111111111111111111111111111111",
                    "filename": "also-secret.pdf",
                    "mime": "application/pdf",
                    "size": 10
                }]
            }),
        )
        .await;
    assert_eq!(status, 200, "human send: {sent}");
    let dispatch = loop {
        let raw = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
            .await
            .expect("gateway frame timed out")
            .unwrap()
            .unwrap();
        let Message::Text(text) = raw else { continue };
        let frame: Value = serde_json::from_str(&text).unwrap();
        if frame["op"] == "DISPATCH" && frame["t"] == "MESSAGE_CREATE" {
            break frame["d"].clone();
        }
    };
    assert_eq!(dispatch["content"], "");
    assert_eq!(dispatch["content_redacted"], true);
    assert_eq!(
        dispatch["attachments"],
        json!([]),
        "the socket must take attachments too, or REST and gateway disagree: {dispatch}"
    );
    socket.close(None).await.unwrap();

    let (status, history) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/messages"), &owner_guild)
        .await;
    assert_eq!(status, 200, "human history: {history}");
    assert_eq!(history["messages"][0]["content"], "the redundancy list is attached");
    assert_eq!(
        history["messages"][0]["attachments"][0]["filename"],
        "q3-redundancies-final.pdf"
    );
    assert!(history["messages"][0].get("content_redacted").is_none());
    let (_, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=redundancy"), &owner_guild)
        .await;
    assert_eq!(
        found["results"][0]["content"],
        "the redundancy list is attached",
        "human search must be untouched: {found}"
    );
}

#[tokio::test]
async fn rest_reads_return_message_content_to_a_bot_the_guild_granted_it() {
    let s = RestServer::start().await;
    let (_, owner_home, owner_guild) = s.human("grantowner").await;

    let (status, guild) = s
        .post("/_telium/v1/guilds", Some(&owner_guild), json!({ "name": "Granted" }))
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&guild_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();

    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&owner_guild),
            json!({ "content": "the bot is supposed to read this" }),
        )
        .await;
    assert_eq!(status, 200, "human send: {sent}");

    let (bot_user_id, bot_session) = install_bot(
        &s,
        &owner_home,
        &owner_guild,
        &guild_id,
        "readerbot",
        &["GUILD_MESSAGES", "GUILD_STRUCTURE", "MESSAGE_CONTENT"],
    )
    .await;

    let (status, history) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/messages"), &bot_session)
        .await;
    assert_eq!(status, 200, "bot history: {history}");
    assert_eq!(history["messages"][0]["content"], "the bot is supposed to read this");
    assert!(
        history["messages"][0].get("content_redacted").is_none(),
        "a granted bot must not be told its content was withheld: {history}"
    );

    let (status, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=supposed"), &bot_session)
        .await;
    assert_eq!(status, 200, "bot search: {found}");
    assert_eq!(found["results"][0]["content"], "the bot is supposed to read this");

    let (status, patched) = s
        .patch(
            &format!("/_telium/v1/guilds/{guild_id}/bots/{bot_user_id}"),
            &owner_guild,
            json!({ "intents": ["GUILD_MESSAGES", "GUILD_STRUCTURE"] }),
        )
        .await;
    assert_eq!(status, 200, "narrow grant: {patched}");

    let (_, history) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/messages"), &bot_session)
        .await;
    assert_eq!(
        history["messages"][0]["content"], "",
        "a withdrawn grant must bite the very next read: {history}"
    );
    let (_, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=supposed"), &bot_session)
        .await;
    assert_eq!(found["results"][0]["content"], "", "search kept reading after withdrawal: {found}");
}

#[tokio::test]
async fn search_needs_read_message_history_and_not_merely_a_visible_channel() {
    let s = RestServer::start().await;
    let (_, _owner_home, owner_guild) = s.human("historyowner").await;
    let (_, _member_home, member_guild) = s.human("historymember").await;

    let (status, guild) = s
        .post("/_telium/v1/guilds", Some(&owner_guild), json!({ "name": "Backlog" }))
        .await;
    assert_eq!(status, 200, "create guild: {guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&guild_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();

    let (status, invite) = s
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/invites"),
            Some(&owner_guild),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "invite: {invite}");
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, joined) = s
        .post(&format!("/_telium/v1/invites/{code}/join"), Some(&member_guild), json!({}))
        .await;
    assert_eq!(status, 200, "join: {joined}");

    s.post(
        &format!("/_telium/v1/channels/{channel_id}/messages"),
        Some(&owner_guild),
        json!({ "content": "the backlog nobody new should read" }),
    )
    .await;

    let read_message_history = (1u64 << 21).to_string();
    let (status, overwritten) = s
        .put(
            &format!("/_telium/v1/channels/{channel_id}/overwrites/role/{guild_id}"),
            &owner_guild,
            json!({ "allow": "0", "deny": read_message_history }),
        )
        .await;
    assert_eq!(status, 200, "overwrite: {overwritten}");

    let (status, _) = s
        .get(&format!("/_telium/v1/channels/{channel_id}/messages"), &member_guild)
        .await;
    assert_eq!(status, 403, "history must refuse without READ_MESSAGE_HISTORY");

    let (status, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=backlog"), &member_guild)
        .await;
    assert_eq!(status, 200, "search: {found}");
    assert_eq!(
        found["count"], 0,
        "search must not be a way around READ_MESSAGE_HISTORY: {found}"
    );
    assert_eq!(found["results"], json!([]));

    let (status, _) = s
        .get(
            &format!("/_telium/v1/guilds/{guild_id}/search?q=backlog&channel_id={channel_id}"),
            &member_guild,
        )
        .await;
    assert_eq!(status, 404, "a channel the member may not read must not be searchable by name");

    let (status, found) = s
        .get(&format!("/_telium/v1/guilds/{guild_id}/search?q=backlog"), &owner_guild)
        .await;
    assert_eq!(status, 200, "owner search: {found}");
    assert_eq!(found["count"], 1, "the fix must not narrow anyone who does hold the bit: {found}");
}
