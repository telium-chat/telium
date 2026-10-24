
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::perms::{self, *};
use tokio_tungstenite::tungstenite::Message;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    ws: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-perms-{}-{n}", std::process::id()));
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
    cfg.rate_limit.enabled = false;
    cfg.voice.regions = vec![telium_server::config::VoiceRegion {
        name: "eu".into(),
        sfu: "https://sfu.invalid".into(),
        turn: None,
        pubkey_hint: None,
    }];
    cfg.voice.default_region = "eu".into();
    cfg.voice.stun_servers = vec!["stun:stun.invalid:3478".into()];
    cfg.voice.max_streamers_per_channel = 64;
    let state = telium_server::build_state(cfg).await.unwrap();
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
        dir,
        state,
    }
}

struct User {
    user_id: String,
    home: String,
    token: String,
}

impl Server {
    async fn call(&self, method: &str, path: &str, token: &str, body: Value) -> (u16, Value) {
        let mut req =
            self.client.request(method.parse().unwrap(), format!("{}/_telium/v1{path}", self.base));
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        if !body.is_null() {
            req = req.json(&body);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn expect(&self, token: &str, cases: Vec<(&str, String, Value, u16)>) {
        for (method, path, body, want) in cases {
            let (status, answer) = self.call(method, &path, token, body).await;
            assert_eq!(status, want, "{method} {path}: {answer}");
        }
    }

    async fn session(&self, home: &str) -> String {
        let (status, s) = self.call("POST", "/sessions/local", home, json!({})).await;
        assert_eq!(status, 200, "session: {s}");
        s["session_token"].as_str().unwrap().to_string()
    }

    async fn user(&self, localpart: &str) -> User {
        let (status, body) = self
            .call("POST", "/register", "", json!({ "localpart": localpart, "password": "correct horse battery" }))
            .await;
        assert_eq!(status, 200, "register {localpart}: {body}");
        let home = body["access_token"].as_str().unwrap().to_string();
        let user_id = body["user_id"].as_str().unwrap().to_string();
        User { user_id, token: self.session(&home).await, home }
    }
}

fn png_b64() -> String {
    let image = image::RgbaImage::from_fn(16, 16, |x, y| image::Rgba([(x * 16) as u8, (y * 16) as u8, 128, 255]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image).write_to(&mut out, image::ImageFormat::Png).unwrap();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

struct G {
    s: Server,
    owner: User,
    gid: String,
    cid: String,
}

async fn guild() -> G {
    let s = start().await;
    let owner = s.user("owner").await;
    let (status, guild) = s.call("POST", "/guilds", &owner.token, json!({ "name": "Guild" })).await;
    assert_eq!(status, 200, "create guild: {guild}");
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = s.call("GET", &format!("/guilds/{gid}/channels"), &owner.token, Value::Null).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    G { s, owner, gid, cid }
}

impl G {
    fn gp(&self, rest: &str) -> String {
        format!("/guilds/{}{rest}", self.gid)
    }

    async fn member(&self, localpart: &str) -> User {
        let who = self.s.user(localpart).await;
        let (_, invite) = self.s.call("POST", &self.gp("/invites"), &self.owner.token, json!({})).await;
        let code = invite["code"].as_str().unwrap();
        let (status, joined) = self.s.call("POST", &format!("/invites/{code}/join"), &who.token, json!({})).await;
        assert_eq!(status, 200, "{localpart} joins: {joined}");
        who
    }

    async fn role(&self, name: &str, bits: u64, position: i64) -> String {
        let body = json!({ "name": name, "permissions": bits_to_names(bits), "position": position });
        let (status, role) = self.s.call("POST", &self.gp("/roles"), &self.owner.token, body).await;
        assert_eq!(status, 200, "create role {name}: {role}");
        role["id"].as_str().unwrap().to_string()
    }

    async fn give(&self, role: &str, user: &str) {
        let (status, body) = self
            .s
            .call("PATCH", &self.gp(&format!("/members/{user}")), &self.owner.token, json!({ "add_roles": [role] }))
            .await;
        assert_eq!(status, 200, "grant {role}: {body}");
    }

    async fn ranked(&self, localpart: &str, bits: u64, position: i64) -> User {
        let who = self.member(localpart).await;
        let role = self.role(localpart, bits, position).await;
        self.give(&role, &who.user_id).await;
        who
    }

    async fn set_everyone(&self, bits: u64) {
        let path = self.gp(&format!("/roles/{}", self.gid));
        let (status, body) =
            self.s.call("PATCH", &path, &self.owner.token, json!({ "permissions": bits_to_names(bits) })).await;
        assert_eq!(status, 200, "set @everyone: {body}");
    }

    async fn overwrite(&self, kind: &str, target: &str, allow: u64, deny: u64) {
        let path = format!("/channels/{}/overwrites/{kind}/{target}", self.cid);
        let body = json!({ "allow": allow.to_string(), "deny": deny.to_string() });
        let (status, answer) = self.s.call("PUT", &path, &self.owner.token, body).await;
        assert_eq!(status, 200, "set {kind} overwrite: {answer}");
    }

    async fn say(&self, token: &str, what: &str) -> (u16, Value) {
        self.s.call("POST", &format!("/channels/{}/messages", self.cid), token, json!({ "content": what })).await
    }

    async fn timeout(&self, user: &str, until: Value) {
        let (status, body) = self
            .s
            .call("PATCH", &self.gp(&format!("/members/{user}")), &self.owner.token, json!({ "timeout_until": until }))
            .await;
        assert_eq!(status, 200, "timeout: {body}");
    }

    async fn me(&self, token: &str) -> Value {
        self.s.call("GET", &self.gp(""), token, Value::Null).await.1["me"].clone()
    }
}

fn table_from_name_map() -> Vec<(&'static str, u64)> {
    let mut out = Vec::new();
    for shift in 0..64u32 {
        let bit = 1u64 << shift;
        let named = bits_to_names(bit);
        assert!(named.len() <= 1, "bit {bit} names {named:?}");
        if let Some(name) = named.first() {
            assert_eq!(name_to_bit(name), Some(bit), "{name} does not round-trip");
            out.push((*name, bit));
        }
    }
    out
}

#[test]
fn the_permission_constants_and_the_name_table_say_the_same_thing() {
    let mut from_text: Vec<(String, u64)> = include_str!("../src/perms.rs")
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix("pub const ")?;
            let (name, value) = rest.split_once(": u64 = ")?;
            let shift = value.trim().strip_suffix(';')?.trim().strip_prefix("1 << ")?.parse::<u32>().ok()?;
            Some((name.trim().to_string(), 1u64 << shift))
        })
        .collect();
    let mut from_map: Vec<(String, u64)> =
        table_from_name_map().into_iter().map(|(n, b)| (n.to_string(), b)).collect();
    from_text.sort();
    from_map.sort();
    assert!(!from_text.is_empty(), "the source-text cross-check found no constants");
    assert_eq!(from_text, from_map, "perms.rs constants and bits_to_names disagree");
}

const FLOOR: u64 = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;

fn scaffold(name: &str) -> u64 {
    match name {
        "USE_EXTERNAL_EMOJI" => ADD_REACTIONS,
        "SPEAK" | "VIDEO" | "STREAM" | "PRIORITY_SPEAKER" => CONNECT,
        _ => 0,
    }
}

struct Matrix {
    g: G,
    voice: String,
    foreign_emoji: String,
    keep: [String; 2],
}

async fn probe(m: &Matrix, name: &str, token: &str, victim: &str, mid: &str, n: usize) -> Result<(), String> {
    let (g, text, voice) = (&m.g, &m.g.cid, &m.voice);
    if let "SPEAK" | "PRIORITY_SPEAKER" = name {
        let key = if name == "SPEAK" { "speak" } else { "priority" };
        let (status, join) = g.s.call("POST", &format!("/channels/{voice}/voice/join"), token, json!({"key_package": "pkg"})).await;
        let flags = join["voice_server"]["token"]
            .as_str()
            .and_then(telium_server::util::unb64)
            .and_then(|d| serde_json::from_slice::<Value>(&d).ok())
            .map(|c| c["flags"].clone());
        return match flags {
            Some(f) if status == 200 && f[key] == json!(true) => Ok(()),
            other => Err(format!("{status} flags {other:?}")),
        };
    }
    if let "VIDEO" | "STREAM" = name {
        g.s.call("POST", &format!("/channels/{voice}/voice/join"), token, json!({"key_package": "pkg"})).await;
    }
    let msg = |content: &str| json!({ "content": content });
    let (method, path, body) = match name {
        "VIEW_CHANNEL" => ("POST", format!("/channels/{text}/typing"), json!({})),
        "SEND_MESSAGES" => ("POST", format!("/channels/{text}/messages"), msg("hello")),
        "MANAGE_MESSAGES" => ("DELETE", format!("/channels/{text}/messages/{mid}"), Value::Null),
        "MANAGE_CHANNELS" => ("PATCH", format!("/channels/{text}"), json!({ "topic": "renamed" })),
        "MANAGE_ROLES" => ("POST", g.gp("/roles"), json!({ "name": "probe", "position": 1 })),
        "KICK_MEMBERS" => ("DELETE", g.gp(&format!("/members/{victim}")), Value::Null),
        "BAN_MEMBERS" => ("PUT", g.gp(&format!("/bans/{victim}")), json!({})),
        "MANAGE_GUILD" | "ADMINISTRATOR" => ("GET", g.gp("/invites"), Value::Null),
        "MANAGE_EXPRESSIONS" => (
            "POST",
            g.gp("/emojis"),
            json!({ "name": format!("probe{n}"), "data": png_b64(), "mime": "image/png" }),
        ),
        "CREATE_INVITE" => ("POST", g.gp("/invites"), json!({})),
        "ATTACH_FILES" => (
            "POST",
            format!("/channels/{text}/messages"),
            json!({ "content": "file", "attachments": [{
                "origin": "test.example", "hash": "1".repeat(64), "filename": "cat.png",
                "mime": "image/png", "size": 12 }] }),
        ),
        "MENTION_EVERYONE" => ("POST", format!("/channels/{text}/messages"), msg("@everyone hi")),
        "MODERATE_MEMBERS" => {
            ("PATCH", g.gp(&format!("/members/{victim}")), json!({ "timeout_until": now_ms() + 60_000 }))
        }
        "USE_EXTERNAL_EMOJI" => {
            ("PUT", format!("/messages/{mid}/reactions/{}/@me", urlencode(&m.foreign_emoji)), json!({}))
        }
        "CONNECT" => ("POST", format!("/channels/{voice}/voice/join"), json!({"key_package": "pkg"})),
        "VIDEO" => ("POST", format!("/channels/{voice}/voice/state"), json!({ "self_video": true })),
        "STREAM" => ("POST", format!("/channels/{voice}/voice/stream"), json!({ "enabled": true })),
        "VIEW_AUDIT_LOG" => ("GET", g.gp("/audit-log"), Value::Null),
        "ADD_REACTIONS" => ("PUT", format!("/messages/{mid}/reactions/%F0%9F%9A%80/@me"), json!({})),
        "READ_MESSAGE_HISTORY" => ("GET", format!("/channels/{text}/messages"), Value::Null),
        "MUTE_MEMBERS" => ("POST", g.gp(&format!("/voice/{victim}")), json!({ "mute": true })),
        "DEAFEN_MEMBERS" => ("POST", g.gp(&format!("/voice/{victim}")), json!({ "deaf": true })),
        "MOVE_MEMBERS" => ("POST", g.gp(&format!("/voice/{victim}")), json!({ "disconnect": true })),
        _ => panic!("no probe for new permission {name}: add one here"),
    };
    let (status, answer) = g.s.call(method, &path, token, body).await;
    match status {
        401 | 403 | 404 => Err(format!("{status} {answer}")),
        _ => Ok(()),
    }
}

#[tokio::test]
async fn every_permission_is_refused_without_the_bit_and_allowed_with_it() {
    let g = guild().await;
    let t = g.owner.token.clone();
    let (status, voice) =
        g.s.call("POST", &g.gp("/channels"), &t, json!({ "name": "Room", "type": "voice", "voice_region": "eu" })).await;
    assert_eq!(status, 200, "voice channel: {voice}");
    let (_, other) = g.s.call("POST", "/guilds", &t, json!({ "name": "Elsewhere" })).await;
    let (status, emoji) = g
        .s
        .call(
            "POST",
            &format!("/guilds/{}/emojis", other["id"].as_str().unwrap()),
            &t,
            json!({ "name": "parrot", "data": png_b64(), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "foreign emoji: {emoji}");
    let keep = [g.role("floor", 0, 1).await, g.role("rank", 0, 50).await];
    let m = Matrix {
        voice: voice["id"].as_str().unwrap().to_string(),
        foreign_emoji: format!("<parrot:{}>", emoji["id"].as_str().unwrap()),
        keep,
        g,
    };

    let table = table_from_name_map();
    assert!(table.iter().any(|(n, _)| *n == "ADMINISTRATOR"), "{table:?}");
    let mut failures = Vec::new();
    for (n, (name, bit)) in table.into_iter().enumerate() {
        if name == "EMBED_LINKS" {
            continue; // an_application_may_not_attach_cards_without_embed_links
        }
        m.g.set_everyone((FLOOR | scaffold(name)) & !bit).await;
        let actor = m.g.member(&format!("actor{n}")).await;
        m.g.give(&m.keep[1], &actor.user_id).await;
        let victim = m.g.member(&format!("victim{n}")).await;
        let (_, msg) = m.g.say(&t, "somebody else's message").await;
        let mid = msg["id"].as_str().unwrap().to_string();

        let without = probe(&m, name, &actor.token, &victim.user_id, &mid, n).await;
        let grant = m.g.role(name, bit, 1).await;
        m.g.give(&grant, &actor.user_id).await;
        let with = probe(&m, name, &actor.token, &victim.user_id, &mid, n).await;
        match (without, with) {
            (Err(_), Ok(())) => {}
            (Ok(()), _) => failures.push(format!("{name}: allowed without the bit")),
            (_, Err(e)) => failures.push(format!("{name}: refused with the bit: {e}")),
        }

        let (_, roles) = m.g.s.call("GET", &m.g.gp("/roles"), &t, Value::Null).await;
        for role in roles["roles"].as_array().cloned().unwrap_or_default() {
            let id = role["id"].as_str().unwrap_or_default();
            if id != m.g.gid && !m.keep.iter().any(|k| k == id) {
                m.g.s.call("DELETE", &m.g.gp(&format!("/roles/{id}")), &t, Value::Null).await;
            }
        }
    }
    assert!(failures.is_empty(), "permissions not enforced as written:\n  {}", failures.join("\n  "));
}

#[tokio::test]
async fn owners_and_administrators_pass_every_gate_but_only_the_owner_is_above_the_hierarchy() {
    let g = guild().await;
    g.set_everyone(0).await;
    let admin = g.ranked("admin", ADMINISTRATOR, 1).await;
    let senior = g.ranked("senior", 0, 9).await;
    let pawn = g.member("pawn").await;
    let above = g.role("above", 0, 9).await;
    g.overwrite("role", &g.gid, 0, VIEW_CHANNEL | SEND_MESSAGES).await;
    g.overwrite("member", &g.owner.user_id, 0, VIEW_CHANNEL | SEND_MESSAGES).await;

    for who in [&g.owner, &admin] {
        assert_eq!(g.say(&who.token, "in anyway").await.0, 200, "{} was shut out", who.user_id);
        let me = g.me(&who.token).await;
        assert_eq!(me["permissions"], u64::MAX.to_string(), "{me}");
        assert_eq!(me["is_owner"], who.user_id == g.owner.user_id, "{me}");
    }
    let (owner, senior_id, admin_id) = (&g.owner.user_id, &senior.user_id, &admin.user_id);
    g.s.expect(&admin.token, vec![
        ("GET", g.gp("/audit-log"), Value::Null, 200),
        ("GET", g.gp("/invites"), Value::Null, 200),
        ("GET", g.gp("/bans"), Value::Null, 200),
        ("DELETE", g.gp(&format!("/members/{owner}")), Value::Null, 403),
        ("PUT", g.gp(&format!("/bans/{owner}")), json!({}), 403),
        ("PATCH", g.gp(&format!("/members/{owner}")), json!({ "timeout_until": now_ms() + 600_000 }), 403),
        ("PATCH", g.gp(&format!("/members/{owner}")), json!({ "add_roles": [above] }), 403),
        ("POST", g.gp("/transfer-ownership"), json!({ "user_id": admin_id }), 403),
        ("DELETE", g.gp(&format!("/members/{senior_id}")), Value::Null, 403),
        ("PUT", g.gp(&format!("/bans/{senior_id}")), json!({}), 403),
        ("PATCH", g.gp(&format!("/roles/{above}")), json!({ "name": "mine" }), 403),
        ("DELETE", g.gp(&format!("/roles/{above}")), Value::Null, 403),
        ("POST", g.gp("/roles"), json!({ "name": "higher", "position": 20 }), 403),
        ("PATCH", g.gp(&format!("/members/{admin_id}")), json!({ "add_roles": [above] }), 403),
        ("DELETE", g.gp(&format!("/members/{}", pawn.user_id)), Value::Null, 200),
    ])
    .await;
    assert_eq!(g.s.call("POST", &g.gp("/leave"), &g.owner.token, json!({})).await.0, 400, "owner left");
    assert_eq!(g.s.call("POST", &g.gp("/leave"), &admin.token, json!({})).await.0, 200);
}

#[tokio::test]
async fn role_grants_edits_and_moderation_stop_below_your_own_rank() {
    let g = guild().await;
    let keys = g.role("keys", MANAGE_ROLES | KICK_MEMBERS | BAN_MEMBERS | MODERATE_MEMBERS, 1).await;
    let above = g.role("above", 0, 9).await;
    let below = g.role("below", 0, 1).await;
    let keeper = g.member("keeper").await;
    let peer = g.member("peer").await;
    let senior = g.member("senior").await;
    let target = g.member("target").await;
    for (role, who) in [(&keys, &keeper), (&keys, &peer), (&above, &senior)] {
        g.give(role, &who.user_id).await;
    }
    let member = |u: &User| g.gp(&format!("/members/{}", u.user_id));
    let mut cases = vec![
        ("PATCH", member(&target), json!({ "add_roles": [above] }), 403),
        ("PATCH", member(&target), json!({ "add_roles": [keys] }), 403),
        ("PATCH", member(&target), json!({ "add_roles": [below] }), 200),
        ("PATCH", member(&senior), json!({ "remove_roles": [above] }), 403),
        ("PATCH", g.gp(&format!("/roles/{above}")), json!({ "name": "mine" }), 403),
        ("PATCH", g.gp(&format!("/roles/{keys}")), json!({ "name": "mine" }), 403),
        ("DELETE", g.gp(&format!("/roles/{above}")), Value::Null, 403),
        ("PATCH", g.gp(&format!("/roles/{below}")), json!({ "permissions": ["ADMINISTRATOR"] }), 403),
        ("PATCH", g.gp(&format!("/roles/{below}")), json!({ "position": 20 }), 403),
        ("PATCH", g.gp(&format!("/roles/{below}")), json!({ "name": "teal" }), 200),
    ];
    for who in [&senior, &peer] {
        cases.push(("DELETE", member(who), Value::Null, 403));
        cases.push(("PUT", g.gp(&format!("/bans/{}", who.user_id)), json!({}), 403));
        cases.push(("PATCH", member(who), json!({ "timeout_until": now_ms() + 600_000 }), 403));
    }
    cases.push(("PATCH", member(&target), json!({ "timeout_until": now_ms() + 600_000 }), 200));
    cases.push(("DELETE", member(&target), Value::Null, 200));
    g.s.expect(&keeper.token, cases).await;
}

#[tokio::test]
async fn a_moderator_cannot_rename_a_member_who_outranks_them() {
    let g = guild().await;
    let junior = g.ranked("junior", MODERATE_MEMBERS, 1).await;
    let senior = g.ranked("senior", ADMINISTRATOR, 9).await;
    let nick = |u: &str| (g.gp(&format!("/members/{u}")), json!({ "nickname": "renamed" }));
    let mut cases = Vec::new();
    for (who, want) in [(&senior.user_id, 403), (&g.owner.user_id, 403), (&junior.user_id, 200)] {
        let (path, body) = nick(who);
        cases.push(("PATCH", path, body, want));
    }
    g.s.expect(&junior.token, cases).await;
    let (path, body) = nick(&junior.user_id);
    assert_eq!(g.s.call("PATCH", &path, &g.owner.token, body).await.0, 200, "owner renames below");
}

#[tokio::test]
async fn voice_moderation_obeys_the_role_hierarchy() {
    let g = guild().await;
    let helper = g.ranked("helper", MUTE_MEMBERS | DEAFEN_MEMBERS | MOVE_MEMBERS, 1).await;
    let senior = g.ranked("senior", ADMINISTRATOR, 9).await;
    let mut cases = Vec::new();
    for who in [&senior.user_id, &g.owner.user_id] {
        for body in [json!({ "mute": true }), json!({ "deaf": true }), json!({ "disconnect": true })] {
            cases.push(("POST", g.gp(&format!("/voice/{who}")), body, 403));
        }
    }
    g.s.expect(&helper.token, cases).await;
    let path = g.gp(&format!("/voice/{}", helper.user_id));
    assert_eq!(g.s.call("POST", &path, &g.owner.token, json!({ "mute": true })).await.0, 200);
}

#[tokio::test]
async fn overwrites_resolve_in_order_and_cannot_be_used_to_escalate() {
    let g = guild().await;
    let member = g.member("member").await;
    let allower = g.role("speakers", 0, 1).await;
    let denier = g.role("silenced", 0, 1).await;
    g.give(&allower, &member.user_id).await;

    g.overwrite("role", &g.gid, 0, SEND_MESSAGES).await;
    assert_eq!(g.say(&member.token, "1").await.0, 403);
    g.overwrite("role", &allower, SEND_MESSAGES, 0).await;
    assert_eq!(g.say(&member.token, "2").await.0, 200);
    g.give(&denier, &member.user_id).await;
    g.overwrite("role", &denier, 0, SEND_MESSAGES).await;
    assert_eq!(g.say(&member.token, "3").await.0, 200, "a role-tier deny beat a role-tier allow");
    g.overwrite("member", &member.user_id, 0, SEND_MESSAGES).await;
    assert_eq!(g.say(&member.token, "4").await.0, 403);
    g.overwrite("member", &member.user_id, SEND_MESSAGES, 0).await;
    assert_eq!(g.say(&member.token, "5").await.0, 200);

    let keeper = g.ranked("keeper", MANAGE_ROLES, 1).await;
    let above = g.role("above", 0, 9).await;
    let ow = |kind: &str, id: &str| format!("/channels/{}/overwrites/{kind}/{id}", g.cid);
    let bits = |allow: u64, deny: u64| json!({ "allow": allow.to_string(), "deny": deny.to_string() });
    g.s.expect(&keeper.token, vec![
        ("PUT", ow("member", &keeper.user_id), bits(BAN_MEMBERS, 0), 403),
        ("PUT", ow("member", &member.user_id), bits(0, BAN_MEMBERS), 403),
        ("PUT", ow("role", &above), bits(0, SEND_MESSAGES), 403),
        ("PUT", ow("member", &member.user_id), bits(0, SEND_MESSAGES), 200),
    ])
    .await;
    assert_eq!(g.say(&member.token, "muted?").await.0, 403, "accepted overwrite was ignored");
}

#[tokio::test]
async fn a_view_channel_denial_hides_everything_under_the_channel() {
    let g = guild().await;
    let outsider = g.member("outsider").await;
    let (_, msg) = g.say(&g.owner.token, "something private").await;
    let mid = msg["id"].as_str().unwrap().to_string();
    let (status, thread) = g
        .s
        .call("POST", &format!("/channels/{}/threads", g.cid), &g.owner.token, json!({ "title": "t", "content": "hidden" }))
        .await;
    assert_eq!(status, 200, "{thread}");
    let tid = thread["id"].as_str().unwrap().to_string();
    let history = format!("/channels/{}/messages", g.cid);
    g.s.expect(&outsider.token, vec![("GET", history.clone(), Value::Null, 200)]).await;

    g.overwrite("role", &g.gid, 0, VIEW_CHANNEL).await;
    g.s.expect(&outsider.token, vec![
        ("GET", history.clone(), Value::Null, 404),
        ("GET", format!("/channels/{}/pins", g.cid), Value::Null, 404),
        ("GET", format!("/channels/{}/threads", g.cid), Value::Null, 404),
        ("GET", format!("/channels/{tid}/messages"), Value::Null, 404),
        ("PATCH", format!("/threads/{tid}"), json!({ "title": "mine" }), 404),
        ("PUT", format!("/messages/{mid}/reactions/%F0%9F%9A%80/@me"), json!({}), 404),
    ])
    .await;
    let (_, listed) = g.s.call("GET", &g.gp("/channels"), &outsider.token, Value::Null).await;
    assert!(!listed["channels"].as_array().unwrap().iter().any(|c| c["id"] == g.cid.as_str()), "{listed}");
    let (_, found) = g.s.call("GET", &g.gp("/search?q=private"), &outsider.token, Value::Null).await;
    assert!(found["messages"].as_array().map_or(true, |m| m.is_empty()), "search leaked: {found}");
    g.s.expect(&g.owner.token, vec![("GET", history, Value::Null, 200)]).await;
}

#[tokio::test]
async fn only_a_moderator_may_lock_a_thread_and_only_its_author_may_retitle_it() {
    let g = guild().await;
    let author = g.member("author").await;
    let bystander = g.member("bystander").await;
    let moderator = g.ranked("moderator", MANAGE_MESSAGES, 1).await;
    let (status, thread) = g
        .s
        .call("POST", &format!("/channels/{}/threads", g.cid), &author.token, json!({ "title": "mine", "content": "first" }))
        .await;
    assert_eq!(status, 200, "{thread}");
    let tid = thread["id"].as_str().unwrap();
    let (th, post) = (format!("/threads/{tid}"), format!("/channels/{tid}/messages"));
    let steps = [
        (&bystander, "PATCH", &th, json!({ "title": "not mine" }), 403),
        (&author, "PATCH", &th, json!({ "title": "renamed" }), 200),
        (&author, "PATCH", &th, json!({ "locked": true }), 403),
        (&moderator, "PATCH", &th, json!({ "locked": true }), 200),
        (&author, "POST", &post, json!({ "content": "again" }), 403),
        (&moderator, "POST", &post, json!({ "content": "closing" }), 200),
    ];
    for (who, method, path, body, want) in steps {
        let (status, answer) = g.s.call(method, path, &who.token, body).await;
        assert_eq!(status, want, "{method} {path} by {}: {answer}", who.user_id);
    }
}

#[tokio::test]
async fn invite_and_expression_powers_are_separate_from_each_other() {
    let g = guild().await;
    g.set_everyone(FLOOR).await;
    let greeter = g.ranked("greeter", CREATE_INVITE, 1).await;
    let steward = g.ranked("steward", MANAGE_GUILD, 1).await;
    let curator = g.ranked("curator", MANAGE_EXPRESSIONS, 1).await;
    let plain = g.member("plain").await;

    let (status, invite) = g.s.call("POST", &g.gp("/invites"), &greeter.token, json!({})).await;
    assert_eq!(status, 200, "{invite}");
    let revoke = g.gp(&format!("/invites/{}", invite["code"].as_str().unwrap()));
    g.s.expect(&greeter.token, vec![
        ("GET", g.gp("/invites"), Value::Null, 403),
        ("DELETE", revoke.clone(), Value::Null, 403),
    ])
    .await;
    g.s.expect(&steward.token, vec![
        ("GET", g.gp("/invites"), Value::Null, 200),
        ("POST", g.gp("/invites"), json!({}), 403),
        ("DELETE", revoke, Value::Null, 200),
    ])
    .await;
    let stranger = g.s.user("stranger").await;
    let join = format!("/invites/{}/join", invite["code"].as_str().unwrap());
    assert_ne!(g.s.call("POST", &join, &stranger.token, json!({})).await.0, 200, "revoked invite let somebody in");

    let emoji = json!({ "name": "partyparrot", "data": png_b64(), "mime": "image/png" });
    let (status, created) = g.s.call("POST", &g.gp("/emojis"), &curator.token, emoji).await;
    assert_eq!(status, 200, "{created}");
    let path = g.gp(&format!("/emojis/{}", created["id"].as_str().unwrap()));
    g.s.expect(&plain.token, vec![("DELETE", path.clone(), Value::Null, 403)]).await;
    g.s.expect(&curator.token, vec![("DELETE", path, Value::Null, 200)]).await;
}

#[tokio::test]
async fn ownership_moves_only_from_the_owner_to_a_real_member_and_moves_completely() {
    let g = guild().await;
    let heir = g.member("heir").await;
    let bystander = g.member("bystander").await;
    let banned = g.member("banned").await;
    let stranger = g.s.user("stranger").await;
    let transfer = g.gp("/transfer-ownership");
    let to = |u: &User| json!({ "user_id": u.user_id });
    g.s.expect(&bystander.token, vec![("POST", transfer.clone(), to(&bystander), 403)]).await;
    g.s.expect(&g.owner.token, vec![
        ("PUT", g.gp(&format!("/bans/{}", banned.user_id)), json!({}), 200),
        ("POST", transfer.clone(), to(&g.owner), 400),
        ("POST", transfer.clone(), to(&stranger), 400),
        ("POST", transfer.clone(), to(&banned), 400),
        ("POST", transfer.clone(), to(&heir), 200),
    ])
    .await;
    let (new, old) = (g.me(&heir.token).await, g.me(&g.owner.token).await);
    assert_eq!((new["is_owner"].clone(), new["permissions"].clone()), (json!(true), json!(u64::MAX.to_string())));
    assert_eq!(old["is_owner"], false, "{old}");
    assert_ne!(old["permissions"], u64::MAX.to_string(), "{old}");
    g.s.expect(&g.owner.token, vec![("POST", transfer, to(&g.owner), 403)]).await;
    g.s.expect(&heir.token, vec![("DELETE", g.gp(&format!("/members/{}", g.owner.user_id)), Value::Null, 200)]).await;
}

#[tokio::test]
async fn a_timed_out_member_may_look_but_not_touch() {
    let g = guild().await;
    g.set_everyone(FLOOR | ADD_REACTIONS).await;
    let loud = g.member("loud").await;
    let admin = g.ranked("admin", ADMINISTRATOR, 1).await;
    let (_, msg) = g.say(&g.owner.token, "the argument").await;
    let mid = msg["id"].as_str().unwrap();
    let history = format!("/channels/{}/messages", g.cid);

    let (status, _) = g
        .s
        .call("PATCH", &g.gp(&format!("/members/{}", g.owner.user_id)), &admin.token, json!({ "timeout_until": now_ms() + 60_000 }))
        .await;
    assert_eq!(status, 403, "the owner was timed out");
    g.timeout(&loud.user_id, json!(now_ms() + 3_600_000)).await;
    g.timeout(&admin.user_id, json!(now_ms() + 3_600_000)).await;
    for who in [&loud, &admin] {
        g.s.expect(&who.token, vec![
            ("GET", history.clone(), Value::Null, 200),
            ("POST", history.clone(), json!({ "content": "but" }), 403),
            ("PUT", format!("/messages/{mid}/reactions/%F0%9F%9A%80/@me"), json!({}), 403),
            ("POST", format!("/channels/{}/threads", g.cid), json!({ "title": "side", "content": "x" }), 403),
        ])
        .await;
    }
    let roles = vec![(g.gid.clone(), 0u64)];
    let ctx = MemberContext {
        user_id: &g.owner.user_id,
        guild_id: &g.gid,
        guild_owner: &g.owner.user_id,
        roles: &roles,
        permission_ceiling: None,
        timed_out: true,
    };
    assert_eq!(channel_permissions(&ctx, &[]), TIMEOUT_ALLOWED);
    assert_eq!(base_permissions(&ctx), u64::MAX, "base_permissions is the unmasked grant");

    g.timeout(&loud.user_id, Value::Null).await;
    assert_eq!(g.say(&loud.token, "still muted").await.0, 403);
    g.timeout(&loud.user_id, json!(now_ms() - 1)).await;
    assert_eq!(g.say(&loud.token, "sorry").await.0, 200);
}

#[tokio::test]
async fn a_timeout_stops_a_moderator_from_moderating() {
    let g = guild().await;
    let bits = KICK_MEMBERS | BAN_MEMBERS | CREATE_INVITE | MANAGE_ROLES | VIEW_AUDIT_LOG | MUTE_MEMBERS;
    let rogue = g.ranked("rogue", bits, 1).await;
    let victim = g.member("victim").await;
    g.timeout(&rogue.user_id, json!(now_ms() + 3_600_000)).await;
    g.s.expect(&rogue.token, vec![
        ("POST", format!("/channels/{}/messages", g.cid), json!({ "content": "x" }), 403),
        ("POST", g.gp("/invites"), json!({}), 403),
        ("POST", g.gp("/roles"), json!({ "name": "spite" }), 403),
        ("GET", g.gp("/audit-log"), Value::Null, 403),
        ("POST", g.gp(&format!("/voice/{}", victim.user_id)), json!({ "mute": true }), 403),
        ("PUT", g.gp(&format!("/bans/{}", victim.user_id)), json!({}), 403),
    ])
    .await;
}

fn ow(kind: &str, id: &str, allow: u64, deny: u64) -> Overwrite {
    Overwrite { target_type: kind.into(), target_id: id.into(), allow, deny }
}

fn ctx<'a>(roles: &'a [(String, u64)], owner: &'a str) -> MemberContext<'a> {
    MemberContext { user_id: "me", guild_id: "guild", guild_owner: owner, roles, permission_ceiling: None, timed_out: false }
}

fn roles(r: &[(&str, u64)]) -> Vec<(String, u64)> {
    r.iter().map(|(id, p)| (id.to_string(), *p)).collect()
}

#[test]
fn the_resolver_agrees_with_the_endpoints_about_who_holds_what() {
    let (r_plain, r_admin, r_boss) =
        (roles(&[("guild", VIEW_CHANNEL), ("r", SEND_MESSAGES)]), roles(&[("guild", 0), ("r", ADMINISTRATOR)]), roles(&[("guild", 0)]));
    let (plain, admin, boss) = (ctx(&r_plain, "boss"), ctx(&r_admin, "boss"), ctx(&r_boss, "me"));
    assert_eq!(base_permissions(&plain), VIEW_CHANNEL | SEND_MESSAGES);
    assert_eq!(base_permissions(&admin), u64::MAX);
    assert_eq!(base_permissions(&boss), u64::MAX);
    let shut = [ow("role", "guild", 0, u64::MAX)];
    assert_eq!(channel_permissions(&boss, &shut), u64::MAX);
    assert_eq!(channel_permissions(&admin, &shut), u64::MAX);

    let r_member = roles(&[("guild", VIEW_CHANNEL | SEND_MESSAGES), ("loud", 0), ("quiet", 0)]);
    let member = ctx(&r_member, "boss");
    let mut tiers = vec![
        ow("role", "guild", 0, SEND_MESSAGES),
        ow("role", "loud", SEND_MESSAGES, 0),
        ow("role", "quiet", 0, SEND_MESSAGES),
    ];
    assert!(has(channel_permissions(&member, &tiers), SEND_MESSAGES), "allow wins within a tier");
    tiers.push(ow("member", "me", 0, SEND_MESSAGES));
    assert!(!has(channel_permissions(&member, &tiers), SEND_MESSAGES), "member tier is last");
    assert!(!has(channel_permissions(&member, &[ow("role", "stranger", BAN_MEMBERS, 0)]), BAN_MEMBERS));

    for (a, a_owner, t, t_owner, want) in
        [(0, true, 99, false, true), (99, false, 0, true, false), (0, true, 0, true, false), (5, false, 5, false, false), (6, false, 5, false, true), (5, false, 6, false, false)]
    {
        assert_eq!(perms::outranks(a, a_owner, t, t_owner), want, "outranks({a}, {a_owner}, {t}, {t_owner})");
    }
}

#[tokio::test]
async fn an_application_may_not_attach_cards_without_embed_links() {
    let g = guild().await;
    let base = ["VIEW_CHANNEL", "SEND_MESSAGES", "READ_MESSAGE_HISTORY"];
    let (status, app) = g
        .s
        .call(
            "POST",
            "/applications",
            &g.owner.home,
            json!({ "name": "Carder", "localpart": "carder", "allowed_intents": ["GUILD_MESSAGES"], "default_permissions": base }),
        )
        .await;
    assert_eq!(status, 200, "create application: {app}");
    let install = json!({
        "application_id": app["id"], "application_origin": "test.example",
        "intents": ["GUILD_MESSAGES"], "permissions": base,
    });
    let (status, installed) = g.s.call("POST", &g.gp("/bots"), &g.owner.token, install).await;
    assert_eq!(status, 200, "install bot: {installed}");
    let asserted: Value = g
        .s
        .client
        .post(format!("{}/_telium/v1/bots/assertions", g.s.base))
        .header("Authorization", format!("Bot {}", app["token"].as_str().unwrap()))
        .json(&json!({ "audience": "test.example" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let (status, session) =
        g.s.call("POST", "/bots/session", "", json!({ "assertion": asserted["assertion"] })).await;
    assert_eq!(status, 200, "bot session: {session}");
    let bot = session["session_token"].as_str().unwrap();
    let path = format!("/channels/{}/messages", g.cid);
    g.s.expect(bot, vec![
        ("POST", path.clone(), json!({ "content": "plain text" }), 200),
        ("POST", path, json!({ "content": "card", "cards": [{ "title": "Mine" }] }), 403),
    ])
    .await;
}

#[tokio::test]
async fn a_message_can_be_pinned_only_in_its_own_channel() {
    let a = guild().await;
    let (_, secret) = a.say(&a.owner.token, "the combination").await;
    let secret = secret["id"].as_str().unwrap();
    let mallory = a.s.user("mallory").await;
    let (_, den) = a.s.call("POST", "/guilds", &mallory.token, json!({ "name": "Den" })).await;
    let (_, chans) = a.s.call("GET", &format!("/guilds/{}/channels", den["id"].as_str().unwrap()), &mallory.token, Value::Null).await;
    let den_channel = chans["channels"][0]["id"].as_str().unwrap();

    a.s.expect(&mallory.token, vec![("PUT", format!("/channels/{den_channel}/pins/{secret}"), json!({}), 404)]).await;
    let (_, pins) = a.s.call("GET", &format!("/channels/{den_channel}/pins"), &mallory.token, Value::Null).await;
    assert_eq!(pins["pins"].as_array().unwrap().len(), 0, "{pins}");

    a.s.expect(&a.owner.token, vec![("PUT", format!("/channels/{}/pins/{secret}", a.cid), json!({}), 200)]).await;
    let (_, pins) = a.s.call("GET", &format!("/channels/{}/pins", a.cid), &a.owner.token, Value::Null).await;
    assert_eq!(pins["pins"][0]["id"], secret, "{pins}");
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_frame(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(600), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return Some(serde_json::from_str(&t).unwrap()),
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
            Ok(Some(Ok(_))) => continue,
        }
    }
}

async fn wait_for(ws: &mut Ws, t: &str) -> Option<Value> {
    while let Some(frame) = next_frame(ws).await {
        if frame["t"] == t || frame["op"] == t {
            return Some(frame);
        }
    }
    None
}

async fn hello(s: &Server) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next_frame(&mut ws).await.expect("HELLO")["op"], "HELLO");
    ws
}

async fn connect(s: &Server, token: &str, intents: &[&str]) -> Ws {
    let mut ws = hello(s).await;
    let identify = json!({ "op": "IDENTIFY", "d": { "token": token, "intents": intents } });
    ws.send(Message::Text(identify.to_string())).await.unwrap();
    let ready = next_frame(&mut ws).await.expect("READY");
    assert_eq!(ready["op"], "READY", "identify rejected: {ready}");
    ws
}

#[tokio::test]
async fn losing_access_stops_events_on_a_socket_already_open() {
    let g = guild().await;
    let bob = g.member("bob").await;
    let carol = g.member("carol").await;

    let mut ws = connect(&g.s, &bob.token, &["GUILD_MESSAGES"]).await;
    g.say(&g.owner.token, "before").await;
    assert!(wait_for(&mut ws, "MESSAGE_CREATE").await.is_some(), "bob sees the channel at first");
    g.overwrite("member", &bob.user_id, 0, VIEW_CHANNEL).await;
    g.say(&g.owner.token, "after").await;
    assert!(wait_for(&mut ws, "MESSAGE_CREATE").await.is_none(), "socket kept reading a hidden channel");

    let mut ws = connect(&g.s, &carol.token, &["GUILD_MESSAGES", "GUILD_MEMBERS", "GUILD_STRUCTURE"]).await;
    g.s.expect(&g.owner.token, vec![("DELETE", g.gp(&format!("/members/{}", carol.user_id)), Value::Null, 200)]).await;
    let told = wait_for(&mut ws, "MEMBER_REMOVE").await.expect("MEMBER_REMOVE");
    assert_eq!(told["d"]["user_id"], carol.user_id.as_str());
    g.s.expect(&g.owner.token, vec![("POST", g.gp("/roles"), json!({ "name": "after" }), 200)]).await;
    assert!(wait_for(&mut ws, "ROLE_CREATE").await.is_none(), "kicked member kept the role feed");
}

#[tokio::test]
async fn an_oversized_frame_before_identify_is_not_answered() {
    let s = start().await;
    let alice = s.user("alice").await;
    let mut ws = hello(&s).await;
    let huge = json!({ "op": "HEARTBEAT", "padding": "A".repeat(1024 * 1024) }).to_string();
    let _ = ws.send(Message::Text(huge)).await;
    assert!(wait_for(&mut ws, "HEARTBEAT_ACK").await.is_none(), "a megabyte frame was accepted");

    let mut ws = connect(&s, &alice.token, &["GUILD_MESSAGES"]).await;
    ws.send(Message::Text(json!({ "op": "HEARTBEAT" }).to_string())).await.unwrap();
    assert!(wait_for(&mut ws, "HEARTBEAT_ACK").await.is_some(), "ordinary heartbeat not acked");
}

#[tokio::test]
async fn logging_out_ends_that_device_only() {
    let g = guild().await;
    let (status, phone) =
        g.s.call("POST", "/login", "", json!({ "user": "owner", "password": "correct horse battery" })).await;
    assert_eq!(status, 200, "second login: {phone}");
    let phone = g.s.session(phone["access_token"].as_str().unwrap()).await;
    let mut ws = connect(&g.s, &g.owner.token, &["GUILD_MESSAGES"]).await;

    g.s.expect(&g.owner.home, vec![("POST", "/logout".to_string(), json!({}), 200)]).await;
    let mut closed = false;
    for _ in 0..10 {
        if next_frame(&mut ws).await.is_none() {
            closed = true;
            break;
        }
    }
    assert!(closed, "the socket outlived the logout");
    let history = format!("/channels/{}/messages", g.cid);
    g.s.expect(&g.owner.token, vec![("GET", history.clone(), Value::Null, 401)]).await;
    g.s.expect(&phone, vec![("GET", history, Value::Null, 200)]).await;
}

#[tokio::test]
async fn a_guild_that_has_relocated_refuses_moderation_writes_but_still_answers_reads() {
    let g = guild().await;
    let rule = json!({
        "name": "no shouting", "kind": "keyword", "pattern": "shout",
        "actions": [{ "kind": "delete", "after": 0, "duration_secs": 0 }],
    });
    let (status, created) = g.s.call("POST", &g.gp("/automod"), &g.owner.token, rule.clone()).await;
    assert_eq!(status, 200, "{created}");
    let one = g.gp(&format!("/automod/{}", created["id"].as_str().unwrap()));
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 0)",
    )
    .bind(&g.gid)
    .execute(&g.s.state.pool)
    .await
    .unwrap();
    g.s.expect(&g.owner.token, vec![
        ("PATCH", one.clone(), rule.clone(), 403),
        ("DELETE", one, Value::Null, 403),
        ("POST", g.gp("/moderation/purge"), json!({ "user_id": g.owner.user_id, "limit": 100 }), 403),
        ("POST", g.gp("/automod"), rule, 403),
        ("GET", g.gp("/automod"), Value::Null, 200),
    ])
    .await;
}
