
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use telium_server::config::Config;
use telium_server::gateway::local_apps::{
    self, BoxFuture, LocalApplication, LocalInteraction, LocalInteractionContext,
};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
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
    start_with(false).await
}

async fn start_with(rate_limits: bool) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir =
        std::env::temp_dir().join(format!("telium-interaction-test-{}-{n}", std::process::id()));
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
    cfg.rate_limit.enabled = rate_limits;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), state, dir }
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

    async fn patch(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.patch(format!("{}{path}", self.base)).json(&body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let response = req.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(json!(null)))
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
        let (status, guild) =
            self.post("/_telium/v1/sessions/local", Some(&home), json!({})).await;
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

struct App {
    id: String,
    bot_user_id: String,
    #[allow(dead_code)]
    bot_token: String,
    session: String,
}

struct Guild {
    id: String,
    channel_id: String,
}

async fn make_guild(s: &Server, owner: &User, name: &str) -> Guild {
    let (status, guild) =
        s.post("/_telium/v1/guilds", Some(&owner.guild), json!({ "name": name })).await;
    assert_eq!(status, 200, "create guild: {guild}");
    let id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    Guild { id, channel_id }
}

async fn install_app(s: &Server, owner: &User, guild: &Guild, localpart: &str) -> App {
    let (status, app) = s
        .post(
            "/_telium/v1/applications",
            Some(&owner.home),
            json!({
                "name": localpart,
                "localpart": localpart,
                "allowed_intents": ["GUILD_MESSAGES", "GUILD_MEMBERS"],
                "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "create app: {app}");
    let id = app["id"].as_str().unwrap().to_string();
    let bot_user_id = app["bot_user_id"].as_str().unwrap().to_string();
    let bot_token = app["token"].as_str().unwrap().to_string();

    let (status, installed) = s
        .post(
            &format!("/_telium/v1/guilds/{}/bots", guild.id),
            Some(&owner.guild),
            json!({
                "application_id": id,
                "application_origin": "test.example",
                "intents": ["GUILD_MESSAGES"],
                "permissions": ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"]
            }),
        )
        .await;
    assert_eq!(status, 200, "install: {installed}");

    let session = bot_session(s, &bot_token).await;
    App { id, bot_user_id, bot_token, session }
}

async fn join_guild(s: &Server, owner: &User, guild: &Guild, joiner: &User) {
    let (status, invite) = s
        .post(
            &format!("/_telium/v1/guilds/{}/invites", guild.id),
            Some(&owner.guild),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "create invite: {invite}");
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, joined) = s
        .post(&format!("/_telium/v1/invites/{code}/join"), Some(&joiner.guild), json!({}))
        .await;
    assert_eq!(status, 200, "join: {joined}");
}

async fn bot_session(s: &Server, bot_token: &str) -> String {
    let (status, asserted) = s
        .post_bot(
            "/_telium/v1/bots/assertions",
            bot_token,
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
    session["session_token"].as_str().unwrap().to_string()
}

fn one_button(custom_id: &str) -> Value {
    json!([{
        "type": "action_row",
        "components": [
            { "type": "button", "style": "primary", "label": "Press", "custom_id": custom_id }
        ]
    }])
}

async fn send_with_components(
    s: &Server,
    app: &App,
    guild: &Guild,
    content: &str,
    components: Value,
) -> Value {
    let (status, body) = s
        .post(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            Some(&app.session),
            json!({ "content": content, "components": components }),
        )
        .await;
    assert_eq!(status, 200, "app send: {body}");
    body
}

async fn press(s: &Server, user: &User, guild: &Guild, message_id: &str, custom_id: &str) -> (u16, Value) {
    s.post(
        &format!(
            "/_telium/v1/channels/{}/messages/{message_id}/interact",
            guild.channel_id
        ),
        Some(&user.guild),
        json!({ "custom_id": custom_id }),
    )
    .await
}

#[derive(Clone)]
struct Recorder {
    id: String,
    seen: Arc<tokio::sync::Mutex<Vec<LocalInteraction>>>,
}

impl LocalApplication for Recorder {
    fn application_id(&self) -> &str {
        &self.id
    }

    fn on_interaction<'a>(
        &'a self,
        _ctx: LocalInteractionContext,
        interaction: LocalInteraction,
    ) -> BoxFuture<'a, ()> {
        let seen = self.seen.clone();
        Box::pin(async move {
            seen.lock().await.push(interaction);
        })
    }
}

impl Recorder {
    fn install(application_id: &str) -> Recorder {
        let recorder =
            Recorder { id: application_id.to_string(), seen: Arc::new(tokio::sync::Mutex::new(Vec::new())) };
        local_apps::register(Arc::new(recorder.clone()));
        recorder
    }

    async fn next(&self) -> LocalInteraction {
        for _ in 0..200 {
            if let Some(first) = self.seen.lock().await.first().cloned() {
                return first;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("no interaction was dispatched to the local application");
    }

    async fn count(&self) -> usize {
        self.seen.lock().await.len()
    }
}

#[tokio::test]
async fn a_human_may_not_attach_components_or_cards_by_any_route() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Authorship").await;

    let (status, body) = s
        .post(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            Some(&owner.guild),
            json!({ "content": "hi", "components": one_button("nope") }),
        )
        .await;
    assert_eq!(status, 403, "a human attached components: {body}");

    let (status, body) = s
        .post(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            Some(&owner.guild),
            json!({ "content": "hi", "cards": [{ "title": "Mine" }] }),
        )
        .await;
    assert_eq!(status, 403, "a human attached a card: {body}");

    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            Some(&owner.guild),
            json!({ "content": "plain" }),
        )
        .await;
    assert_eq!(status, 200, "plain send: {sent}");
    let message_id = sent["id"].as_str().unwrap().to_string();
    assert_eq!(sent["components"], json!([]), "a plain message must read back with no components");

    let (status, body) = s
        .patch(
            &format!("/_telium/v1/channels/{}/messages/{message_id}", guild.channel_id),
            Some(&owner.guild),
            json!({ "content": "plain", "components": one_button("nope") }),
        )
        .await;
    assert_eq!(status, 403, "a human edited components onto their message: {body}");

    let stored: String = sqlx::query_scalar("SELECT components FROM messages WHERE id = ?")
        .bind(&message_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, "[]", "a refused edit must not have written anything");
}

#[tokio::test]
async fn an_application_may_attach_components_and_they_survive_the_round_trip() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Buttons").await;
    let app = install_app(&s, &owner, &guild, "buttonbot").await;

    let sent = send_with_components(&s, &app, &guild, "pick one", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    assert_eq!(sent["components"][0]["components"][0]["custom_id"], "go");

    let (status, history) = s
        .get(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            &owner.guild,
        )
        .await;
    assert_eq!(status, 200, "history: {history}");
    let found = history
        .as_array()
        .or_else(|| history["messages"].as_array())
        .expect("history shape")
        .iter()
        .find(|m| m["id"] == message_id.as_str())
        .expect("message in history")
        .clone();
    assert_eq!(found["components"][0]["components"][0]["custom_id"], "go");
}

#[tokio::test]
async fn the_server_rejects_every_malformed_tree_a_client_might_have_allowed() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Validation").await;
    let app = install_app(&s, &owner, &guild, "validatorbot").await;

    let row = |children: Value| json!([{ "type": "action_row", "components": children }]);
    let button = |id: &str| {
        json!({ "type": "button", "style": "primary", "label": "x", "custom_id": id })
    };

    let cases: Vec<(&str, Value)> = vec![
        (
            "six action rows",
            Value::Array((0..6).map(|i| row(json!([button(&format!("b{i}"))]))[0].clone()).collect()),
        ),
        (
            "six children in a row",
            row(json!((0..6).map(|i| button(&format!("c{i}"))).collect::<Vec<_>>())),
        ),
        (
            "a custom_id of 101 characters",
            row(json!([button(&"x".repeat(101))])),
        ),
        (
            "two components sharing a custom_id",
            json!([
                { "type": "action_row", "components": [button("same")] },
                { "type": "action_row", "components": [button("same")] }
            ]),
        ),
        (
            "a link button that also carries a custom_id",
            row(json!([{
                "type": "button", "style": "link", "label": "x",
                "url": "https://example.com/", "custom_id": "both"
            }])),
        ),
        (
            "a link button with no url",
            row(json!([{ "type": "button", "style": "link", "label": "x" }])),
        ),
        (
            "a pressable button with no custom_id",
            row(json!([{ "type": "button", "style": "primary", "label": "x" }])),
        ),
        (
            "a link to something that is not https",
            row(json!([{
                "type": "button", "style": "link", "label": "x",
                "url": "javascript:alert(1)"
            }])),
        ),
        (
            "a select with twenty-six options",
            row(json!([{
                "type": "select", "custom_id": "s",
                "options": (0..26).map(|i| json!({ "label": format!("o{i}"), "value": format!("v{i}") }))
                    .collect::<Vec<_>>()
            }])),
        ),
        (
            "a select with no options",
            row(json!([{ "type": "select", "custom_id": "s", "options": [] }])),
        ),
        (
            "a select whose options share a value",
            row(json!([{
                "type": "select", "custom_id": "s",
                "options": [
                    { "label": "a", "value": "dup" },
                    { "label": "b", "value": "dup" }
                ]
            }])),
        ),
        (
            "a text input outside a modal",
            row(json!([{
                "type": "text_input", "custom_id": "t", "label": "l", "style": "short"
            }])),
        ),
        (
            "a component at the top level instead of in a row",
            json!([button("loose")]),
        ),
        (
            "an action row nested in an action row",
            row(json!([{ "type": "action_row", "components": [button("deep")] }])),
        ),
    ];

    for (what, components) in cases {
        let (status, body) = s
            .post(
                &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
                Some(&app.session),
                json!({ "content": "x", "components": components }),
            )
            .await;
        assert_eq!(status, 422, "{what} was accepted: {body}");
    }

    let card_cases: Vec<(&str, Value)> = vec![
        (
            "twenty-six fields",
            json!([{ "fields": (0..26).map(|i| json!({ "name": format!("n{i}"), "value": "v" }))
                .collect::<Vec<_>>() }]),
        ),
        ("a card with nothing in it", json!([{}])),
        (
            "a card url that is not https",
            json!([{ "title": "t", "url": "http://example.com/" }]),
        ),
        (
            "an image the application chose the host for",
            json!([{ "title": "t", "image": { "url": "https://evil.example/pixel.png" } }]),
        ),
    ];
    for (what, cards) in card_cases {
        let (status, body) = s
            .post(
                &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
                Some(&app.session),
                json!({ "content": "x", "cards": cards }),
            )
            .await;
        assert_eq!(status, 422, "{what} was accepted: {body}");
    }
}

#[tokio::test]
async fn a_press_dispatches_once_and_the_token_is_spent_by_the_first_response() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "RoundTrip").await;
    let app = install_app(&s, &owner, &guild, "roundbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, pressed) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200, "press: {pressed}");
    assert!(
        pressed.get("token").is_none(),
        "the presser must never be handed the application's token: {pressed}"
    );

    let interaction = recorder.next().await;
    assert_eq!(interaction.kind, "component");
    assert_eq!(interaction.application_id, app.id);
    assert_eq!(interaction.user_id, owner.user_id);
    assert_eq!(interaction.data["custom_id"], "go");
    assert_eq!(interaction.message_id.as_deref(), Some(message_id.as_str()));

    let stored: Option<String> =
        sqlx::query_scalar("SELECT token_hash FROM interactions WHERE id = ?")
            .bind(&interaction.id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    let stored = stored.unwrap();
    assert_ne!(stored, interaction.token, "the clear token was written to the database");

    let callback = format!(
        "/_telium/v1/interactions/{}/{}/callback",
        interaction.id, interaction.token
    );
    let (status, answered) = s
        .post(
            &callback,
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "you pressed go" } }),
        )
        .await;
    assert_eq!(status, 200, "callback: {answered}");
    assert_eq!(answered["content"], "you pressed go");
    assert_eq!(answered["author"], app.bot_user_id.as_str());

    let (status, again) = s
        .post(
            &callback,
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "again" } }),
        )
        .await;
    assert_eq!(status, 409, "the token was accepted twice: {again}");

    let posted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND author_id = ? AND deleted = 0",
    )
    .bind(&guild.channel_id)
    .bind(&app.bot_user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(posted, 2, "the original message and exactly one response");
}

#[tokio::test]
async fn a_press_on_a_component_that_is_not_there_is_refused() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Missing").await;
    let app = install_app(&s, &owner, &guild, "missingbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(
        &s,
        &app,
        &guild,
        "pick",
        json!([{
            "type": "action_row",
            "components": [
                { "type": "button", "style": "primary", "label": "ok", "custom_id": "real" },
                { "type": "button", "style": "secondary", "label": "off", "custom_id": "off", "disabled": true },
                { "type": "button", "style": "link", "label": "docs", "url": "https://example.com/" }
            ]
        }]),
    )
    .await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, body) = press(&s, &owner, &guild, &message_id, "invented").await;
    assert_eq!(status, 404, "an invented custom_id dispatched: {body}");

    let (status, body) = press(&s, &owner, &guild, &message_id, "off").await;
    assert_eq!(status, 404, "a disabled component dispatched: {body}");

    let (status, body) = press(&s, &owner, &guild, &message_id, "https://example.com/").await;
    assert_eq!(status, 404, "a link button dispatched: {body}");

    assert_eq!(recorder.count().await, 0, "nothing should have reached the application");
    let (status, _) = press(&s, &owner, &guild, &message_id, "real").await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_select_press_is_checked_against_the_options_that_were_offered() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Selects").await;
    let app = install_app(&s, &owner, &guild, "selectbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(
        &s,
        &app,
        &guild,
        "choose",
        json!([{
            "type": "action_row",
            "components": [{
                "type": "select", "custom_id": "colour", "min": 1, "max": 2,
                "options": [
                    { "label": "Red", "value": "red" },
                    { "label": "Blue", "value": "blue" }
                ]
            }]
        }]),
    )
    .await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let path = format!(
        "/_telium/v1/channels/{}/messages/{message_id}/interact",
        guild.channel_id
    );

    let (status, body) = s
        .post(&path, Some(&owner.guild), json!({ "custom_id": "colour", "values": ["green"] }))
        .await;
    assert_eq!(status, 400, "an option the application never offered was accepted: {body}");

    let (status, body) = s
        .post(&path, Some(&owner.guild), json!({ "custom_id": "colour", "values": [] }))
        .await;
    assert_eq!(status, 400, "fewer values than the minimum were accepted: {body}");

    let (status, body) = s
        .post(
            &path,
            Some(&owner.guild),
            json!({ "custom_id": "colour", "values": ["red", "blue", "red"] }),
        )
        .await;
    assert_eq!(status, 400, "more values than the maximum were accepted: {body}");

    let (status, body) = s
        .post(&path, Some(&owner.guild), json!({ "custom_id": "colour", "values": ["red", "red"] }))
        .await;
    assert_eq!(status, 400, "a duplicated value was accepted: {body}");

    assert_eq!(recorder.count().await, 0);

    let (status, body) = s
        .post(&path, Some(&owner.guild), json!({ "custom_id": "colour", "values": ["red", "blue"] }))
        .await;
    assert_eq!(status, 200, "a legal selection was refused: {body}");
    let interaction = recorder.next().await;
    assert_eq!(interaction.data["values"], json!(["red", "blue"]));
}

#[tokio::test]
async fn an_expired_token_cannot_be_answered() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Expiry").await;
    let app = install_app(&s, &owner, &guild, "expirybot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;

    sqlx::query("UPDATE interactions SET expires_at = ? WHERE id = ?")
        .bind(1_i64)
        .bind(&interaction.id)
        .execute(&s.state.pool)
        .await
        .unwrap();

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "too late" } }),
        )
        .await;
    assert_eq!(status, 403, "an expired token was accepted: {body}");
}

#[tokio::test]
async fn a_token_cannot_be_guessed_or_reused_against_another_interaction() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Tokens").await;
    let app = install_app(&s, &owner, &guild, "tokenbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let first = recorder.next().await;

    let (status, body) = s
        .post(
            &format!("/_telium/v1/interactions/{}/not-the-token/callback", first.id),
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "x" } }),
        )
        .await;
    assert_eq!(status, 404, "a guessed token was accepted: {body}");

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/01J0000000000000000000000/{}/callback",
                first.token
            ),
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "x" } }),
        )
        .await;
    assert_eq!(status, 404, "a token was accepted against another id: {body}");

    let (status, body) = s
        .post(
            &format!("/_telium/v1/interactions/{}/{}/callback", first.id, first.token),
            Some(&app.session),
            json!({ "type": "message", "data": { "content": "ok" } }),
        )
        .await;
    assert_eq!(status, 200, "a failed attempt burned the real token: {body}");
}

#[tokio::test]
async fn one_application_cannot_answer_another_applications_interaction() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Cross").await;
    let mine = install_app(&s, &owner, &guild, "minebot").await;
    let theirs = install_app(&s, &owner, &guild, "theirbot").await;
    let recorder = Recorder::install(&mine.id);

    let sent = send_with_components(&s, &mine, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;
    assert_eq!(interaction.application_id, mine.id);

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&theirs.session),
            json!({ "type": "message", "data": { "content": "not mine" } }),
        )
        .await;
    assert_eq!(status, 404, "another application answered: {body}");

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&owner.guild),
            json!({ "type": "message", "data": { "content": "me" } }),
        )
        .await;
    assert_eq!(status, 404, "a person answered an interaction: {body}");

    let posted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND author_id = ?",
    )
    .bind(&guild.channel_id)
    .bind(&theirs.bot_user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(posted, 0, "the wrong application posted a message");
}

#[tokio::test]
async fn a_banned_member_and_an_uninstalled_application_both_stop_dispatching() {
    let s = start().await;
    let owner = s.user("owner").await;
    let member = s.user("member").await;
    let guild = make_guild(&s, &owner, "Standing").await;
    let app = install_app(&s, &owner, &guild, "standingbot").await;
    let recorder = Recorder::install(&app.id);

    join_guild(&s, &owner, &guild, &member).await;

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, body) = press(&s, &member, &guild, &message_id, "go").await;
    assert_eq!(status, 200, "a member in good standing was refused: {body}");
    assert_eq!(recorder.count().await, 1);

    sqlx::query("UPDATE members SET banned = 1 WHERE guild_id = ? AND user_id = ?")
        .bind(&guild.id)
        .bind(&member.user_id)
        .execute(&s.state.pool)
        .await
        .unwrap();
    let (status, body) = press(&s, &member, &guild, &message_id, "go").await;
    assert!(
        status == 403 || status == 404,
        "a banned member's press dispatched ({status}): {body}"
    );
    assert_eq!(recorder.count().await, 1, "a banned member reached the application");

    let (status, body) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200, "the ban broke the message for everyone: {body}");
    assert_eq!(recorder.count().await, 2);

    let (status, removed) = s
        .client
        .delete(format!(
            "{}/_telium/v1/guilds/{}/bots/{}",
            s.base, guild.id, app.bot_user_id
        ))
        .bearer_auth(&owner.guild)
        .send()
        .await
        .map(|r| (r.status().as_u16(), r))
        .unwrap();
    assert!(status < 300, "uninstall: {} {:?}", status, removed.text().await);

    let (status, body) = press(&s, &owner, &guild, &message_id, "go").await;
    assert!(
        status == 403 || status == 404,
        "a press dispatched to an uninstalled application ({status}): {body}"
    );
    assert_eq!(recorder.count().await, 2, "an uninstalled application received a press");
}

#[tokio::test]
async fn a_press_from_someone_who_cannot_see_the_channel_is_refused() {
    let s = start().await;
    let owner = s.user("owner").await;
    let outsider = s.user("outsider").await;
    let guild = make_guild(&s, &owner, "Visibility").await;
    let app = install_app(&s, &owner, &guild, "visbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, body) = press(&s, &outsider, &guild, &message_id, "go").await;
    assert!(
        status == 403 || status == 404,
        "a non-member pressed ({status}): {body}"
    );
    assert_eq!(recorder.count().await, 0);
}

#[tokio::test]
async fn an_application_may_not_press_components() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Loops").await;
    let app = install_app(&s, &owner, &guild, "loopbot").await;
    let other = install_app(&s, &owner, &guild, "otherloopbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/channels/{}/messages/{message_id}/interact",
                guild.channel_id
            ),
            Some(&other.session),
            json!({ "custom_id": "go" }),
        )
        .await;
    assert_eq!(status, 403, "an application pressed a button: {body}");
    assert_eq!(recorder.count().await, 0);
}

#[tokio::test]
async fn update_message_rewrites_the_message_the_component_lives_on() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Updates").await;
    let app = install_app(&s, &owner, &guild, "updatebot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "before", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&app.session),
            json!({ "type": "update_message", "data": { "content": "after", "components": [] } }),
        )
        .await;
    assert_eq!(status, 200, "update_message: {body}");

    let (content, components): (String, String) =
        sqlx::query_as("SELECT content, components FROM messages WHERE id = ?")
            .bind(&message_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(content, "after");
    assert_eq!(components, "[]", "the component should be gone");

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND deleted = 0",
    )
    .bind(&guild.channel_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn a_deferred_response_is_completed_by_the_follow_up_patch() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Deferred").await;
    let app = install_app(&s, &owner, &guild, "deferbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;
    let callback = format!(
        "/_telium/v1/interactions/{}/{}/callback",
        interaction.id, interaction.token
    );

    let (status, body) =
        s.patch(&callback, Some(&app.session), json!({ "content": "early" })).await;
    assert_eq!(status, 409, "a follow-up arrived before any response: {body}");

    let (status, body) = s
        .post(&callback, Some(&app.session), json!({ "type": "deferred", "data": {} }))
        .await;
    assert_eq!(status, 200, "deferred: {body}");

    let (status, body) = s
        .patch(&callback, Some(&app.session), json!({ "content": "the slow answer" }))
        .await;
    assert_eq!(status, 200, "follow-up: {body}");
    assert_eq!(body["content"], "the slow answer");

    let (status, body) = s
        .patch(&callback, Some(&app.session), json!({ "content": "corrected" }))
        .await;
    assert_eq!(status, 200, "second follow-up: {body}");

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND author_id = ? AND deleted = 0",
    )
    .bind(&guild.channel_id)
    .bind(&app.bot_user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 2, "the deferred follow-up posted more than one message");

    let content: String = sqlx::query_scalar(
        "SELECT content FROM messages WHERE channel_id = ? AND id != ? AND deleted = 0",
    )
    .bind(&guild.channel_id)
    .bind(&message_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(content, "corrected");
}

#[tokio::test]
async fn an_ephemeral_response_is_never_written_to_the_channel() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Ephemeral").await;
    let app = install_app(&s, &owner, &guild, "ephemeralbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&app.session),
            json!({
                "type": "message",
                "data": {
                    "content": "only you can see this",
                    "ephemeral": true,
                    "components": one_button("confirm")
                }
            }),
        )
        .await;
    assert_eq!(status, 200, "ephemeral response: {body}");
    assert_eq!(body["ephemeral"], true);
    let ephemeral_id = body["id"].as_str().unwrap().to_string();

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = ?")
            .bind(&guild.channel_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "an ephemeral response was persisted as a message");

    let (status, history) = s
        .get(
            &format!("/_telium/v1/channels/{}/messages", guild.channel_id),
            &owner.guild,
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        !history.to_string().contains("only you can see this"),
        "an ephemeral response appeared in history"
    );

    let (status, pressed) = s
        .post(
            &format!(
                "/_telium/v1/channels/{}/ephemeral/{ephemeral_id}/interact",
                guild.channel_id
            ),
            Some(&owner.guild),
            json!({ "custom_id": "confirm" }),
        )
        .await;
    assert_eq!(status, 200, "ephemeral press: {pressed}");

    let other = s.user("nosy").await;
    join_guild(&s, &owner, &guild, &other).await;
    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/channels/{}/ephemeral/{ephemeral_id}/interact",
                guild.channel_id
            ),
            Some(&other.guild),
            json!({ "custom_id": "confirm" }),
        )
        .await;
    assert_eq!(status, 404, "somebody else pressed an ephemeral component: {body}");
}

#[tokio::test]
async fn a_modal_is_opened_submitted_once_and_checked_against_what_was_opened() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Modals").await;
    let app = install_app(&s, &owner, &guild, "modalbot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);
    let interaction = recorder.next().await;

    let (status, body) = s
        .post(
            &format!(
                "/_telium/v1/interactions/{}/{}/callback",
                interaction.id, interaction.token
            ),
            Some(&app.session),
            json!({
                "type": "modal",
                "data": {
                    "custom_id": "report",
                    "title": "Report",
                    "components": [{
                        "type": "action_row",
                        "components": [
                            { "type": "text_input", "custom_id": "why", "label": "Why",
                              "style": "paragraph", "required": true, "max": 20 }
                        ]
                    }]
                }
            }),
        )
        .await;
    assert_eq!(status, 200, "modal: {body}");

    let submit = format!("/_telium/v1/interactions/{}/modal", interaction.id);

    let (status, body) = s
        .post(
            &submit,
            Some(&owner.guild),
            json!({ "components": [{ "custom_id": "invented", "value": "x" }] }),
        )
        .await;
    assert_eq!(status, 400, "an invented field was accepted: {body}");

    let (status, body) = s
        .post(
            &submit,
            Some(&owner.guild),
            json!({ "components": [{ "custom_id": "why", "value": "x".repeat(21) }] }),
        )
        .await;
    assert_eq!(status, 400, "an over-length value was accepted: {body}");

    let (status, body) = s.post(&submit, Some(&owner.guild), json!({ "components": [] })).await;
    assert_eq!(status, 400, "a required field was allowed to be missing: {body}");

    let other = s.user("interloper").await;
    join_guild(&s, &owner, &guild, &other).await;
    let (status, body) = s
        .post(
            &submit,
            Some(&other.guild),
            json!({ "components": [{ "custom_id": "why", "value": "because" }] }),
        )
        .await;
    assert_eq!(status, 404, "someone else submitted the modal: {body}");

    let (status, body) = s
        .post(
            &submit,
            Some(&owner.guild),
            json!({ "components": [{ "custom_id": "why", "value": "because" }] }),
        )
        .await;
    assert_eq!(status, 200, "a legal submission was refused: {body}");
    assert_eq!(body["kind"], "modal_submit");

    let submitted = {
        let mut found = None;
        for _ in 0..200 {
            let seen = recorder.seen.lock().await;
            if let Some(last) = seen.iter().find(|i| i.kind == "modal_submit") {
                found = Some(last.clone());
                break;
            }
            drop(seen);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        found.expect("modal submission was not dispatched")
    };
    assert_ne!(submitted.token, interaction.token);
    assert_eq!(submitted.data["custom_id"], "report");
    assert_eq!(submitted.data["components"][0]["value"], "because");

    let (status, body) = s
        .post(
            &submit,
            Some(&owner.guild),
            json!({ "components": [{ "custom_id": "why", "value": "twice" }] }),
        )
        .await;
    assert_eq!(status, 409, "the modal was submitted twice: {body}");
}

#[tokio::test]
async fn interaction_creation_is_rate_limited_per_person() {
    let s = start_with(true).await;
    let owner = s.user("presser").await;
    let guild = make_guild(&s, &owner, "Limits").await;
    let app = install_app(&s, &owner, &guild, "limitbot").await;
    let _recorder = Recorder::install(&app.id);

    let rows: Vec<Value> = (0..5)
        .map(|r| {
            json!({
                "type": "action_row",
                "components": (0..5).map(|c| json!({
                    "type": "button", "style": "secondary", "label": "x",
                    "custom_id": format!("b{r}{c}")
                })).collect::<Vec<_>>()
            })
        })
        .collect();
    let sent = send_with_components(&s, &app, &guild, "many", json!(rows)).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let mut limited = false;
    for i in 0..200 {
        let custom_id = format!("b{}{}", (i / 5) % 5, i % 5);
        let (status, _) = press(&s, &owner, &guild, &message_id, &custom_id).await;
        if status == 429 {
            limited = true;
            break;
        }
        assert_eq!(status, 200, "press {i} failed for a reason other than the budget");
    }
    assert!(limited, "a person can mint interactions without limit");
}

#[tokio::test]
async fn a_local_application_answers_through_the_same_token_an_http_bot_would() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Local").await;
    let app = install_app(&s, &owner, &guild, "localbot").await;

    struct Responder {
        id: String,
    }
    impl LocalApplication for Responder {
        fn application_id(&self) -> &str {
            &self.id
        }
        fn on_interaction<'a>(
            &'a self,
            ctx: LocalInteractionContext,
            interaction: LocalInteraction,
        ) -> BoxFuture<'a, ()> {
            Box::pin(async move {
                let custom_id = interaction.data["custom_id"].as_str().unwrap_or("").to_string();
                let _ = ctx
                    .respond(json!({
                        "type": "message",
                        "data": { "content": format!("local saw {custom_id}") }
                    }))
                    .await;
            })
        }
    }
    local_apps::register(Arc::new(Responder { id: app.id.clone() }));
    assert!(local_apps::is_local(&app.id));

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, pressed) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200, "press: {pressed}");
    assert_eq!(pressed["local"], true, "the local runtime was not used");

    let mut content = None;
    for _ in 0..200 {
        content = sqlx::query_scalar::<_, String>(
            "SELECT content FROM messages WHERE channel_id = ? AND id != ?",
        )
        .bind(&guild.channel_id)
        .bind(&message_id)
        .fetch_optional(&s.state.pool)
        .await
        .unwrap();
        if content.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(content.as_deref(), Some("local saw go"));

    local_apps::deregister(&app.id);
    assert!(!local_apps::is_local(&app.id));
    let (status, pressed) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200, "press after deregistration: {pressed}");
    assert_eq!(pressed["local"], false);
}

#[tokio::test]
async fn a_local_application_is_validated_exactly_like_a_remote_one() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "LocalValidation").await;
    let app = install_app(&s, &owner, &guild, "localvalbot").await;

    struct Naughty {
        id: String,
        result: Arc<tokio::sync::Mutex<Option<String>>>,
    }
    impl LocalApplication for Naughty {
        fn application_id(&self) -> &str {
            &self.id
        }
        fn on_interaction<'a>(
            &'a self,
            ctx: LocalInteractionContext,
            _interaction: LocalInteraction,
        ) -> BoxFuture<'a, ()> {
            let result = self.result.clone();
            Box::pin(async move {
                let outcome = ctx
                    .respond(json!({
                        "type": "message",
                        "data": {
                            "content": "x",
                            "components": [{
                                "type": "action_row",
                                "components": [
                                    { "type": "button", "style": "link", "label": "x",
                                      "url": "javascript:alert(1)" }
                                ]
                            }]
                        }
                    }))
                    .await;
                *result.lock().await = Some(match outcome {
                    Ok(_) => "accepted".to_string(),
                    Err(err) => format!("{err:?}"),
                });
            })
        }
    }
    let result = Arc::new(tokio::sync::Mutex::new(None));
    local_apps::register(Arc::new(Naughty { id: app.id.clone(), result: result.clone() }));

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();
    let (status, _) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 200);

    let mut outcome = None;
    for _ in 0..200 {
        outcome = result.lock().await.clone();
        if outcome.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let outcome = outcome.expect("the local application never got an answer");
    assert_ne!(outcome, "accepted", "a local application skipped validation");

    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = ?")
            .bind(&guild.channel_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "the invalid response was posted anyway");
    local_apps::deregister(&app.id);
}

#[tokio::test]
async fn deleting_a_message_disarms_its_components() {
    let s = start().await;
    let owner = s.user("owner").await;
    let guild = make_guild(&s, &owner, "Deletion").await;
    let app = install_app(&s, &owner, &guild, "deletebot").await;
    let recorder = Recorder::install(&app.id);

    let sent = send_with_components(&s, &app, &guild, "pick", one_button("go")).await;
    let message_id = sent["id"].as_str().unwrap().to_string();

    let response = s
        .client
        .delete(format!(
            "{}/_telium/v1/channels/{}/messages/{message_id}",
            s.base, guild.channel_id
        ))
        .bearer_auth(&owner.guild)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "delete: {}", response.status());

    let (status, body) = press(&s, &owner, &guild, &message_id, "go").await;
    assert_eq!(status, 404, "a deleted message's button still dispatched: {body}");
    assert_eq!(recorder.count().await, 0);

    let stored: String = sqlx::query_scalar("SELECT components FROM messages WHERE id = ?")
        .bind(&message_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, "[]", "a tombstone kept its components");
}
