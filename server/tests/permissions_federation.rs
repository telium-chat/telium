
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::perms;

static COUNTER: AtomicU32 = AtomicU32::new(0);
const PASSWORD: &str = "correct horse battery";

struct Server {
    name: String,
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    serve: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.serve.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn pair() -> (Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lb = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    (boot(la, "a.test", n, 0, peers.clone()).await, boot(lb, "b.test", n, 1, peers).await)
}

async fn boot(listener: tokio::net::TcpListener, name: &str, n: u32, idx: u32, peers: BTreeMap<String, String>) -> Server {
    let dir = std::env::temp_dir().join(format!("telium-permfed-{}-{n}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: name.into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.federation.allow_http = true;
    cfg.federation.peers = peers;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    Server { name: name.into(), base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state, serve }
}

struct Account {
    token: String,
    user_id: String,
}

impl Server {
    async fn call(&self, method: &str, path: &str, token: &str, body: Value) -> (u16, Value) {
        let mut req = self.client.request(method.parse().unwrap(), format!("{}/_telium/v1{path}", self.base));
        if !body.is_null() {
            req = req.json(&body);
        }
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(Value::Null))
    }

    async fn st(&self, method: &str, path: &str, token: &str, body: Value) -> u16 {
        self.call(method, path, token, body).await.0
    }

    async fn ok(&self, method: &str, path: &str, token: &str, body: Value) -> Value {
        let (status, answer) = self.call(method, path, token, body).await;
        assert_eq!(status, 200, "{method} {path}: {answer}");
        answer
    }

    async fn register(&self, localpart: &str) -> Account {
        let body = self.ok("POST", "/register", "", json!({ "localpart": localpart, "password": PASSWORD })).await;
        Account { token: body["access_token"].as_str().unwrap().into(), user_id: body["user_id"].as_str().unwrap().into() }
    }

    async fn elevate(&self, token: &str) {
        self.ok("POST", "/admin/step-up", token, json!({ "password": PASSWORD })).await;
    }

    async fn local_session(&self, home_token: &str) -> String {
        self.ok("POST", "/sessions/local", home_token, json!({})).await["session_token"].as_str().unwrap().into()
    }

    async fn session_on(&self, home_token: &str, other: &Server) -> String {
        let assertion = self.ok("POST", "/assertions", home_token, json!({ "audience": other.name })).await;
        let session = other.ok("POST", "/sessions", "", json!({ "assertion": assertion["assertion"] })).await;
        session["session_token"].as_str().unwrap().into()
    }

    async fn guild(&self, token: &str, name: &str) -> (String, String) {
        let gid = self.ok("POST", "/guilds", token, json!({ "name": name })).await["id"].as_str().unwrap().to_string();
        let channels = self.ok("GET", &format!("/guilds/{gid}/channels"), token, Value::Null).await;
        let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
        (gid, cid)
    }

    async fn invite_in(&self, guild: &str, owner: &str, joiner: &str) {
        let invite = self.ok("POST", &format!("/guilds/{guild}/invites"), owner, json!({})).await;
        self.ok("POST", &format!("/invites/{}/join", invite["code"].as_str().unwrap()), joiner, json!({})).await;
    }

    async fn me(&self, guild: &str, token: &str) -> Value {
        self.ok("GET", &format!("/guilds/{guild}"), token, Value::Null).await["me"].clone()
    }

    async fn say(&self, token: &str, channel: &str, content: &str) -> String {
        let body = self.ok("POST", &format!("/channels/{channel}/messages"), token, json!({ "content": content })).await;
        body["id"].as_str().unwrap().to_string()
    }

    async fn upload(&self, token: &str, bytes: &[u8]) -> String {
        let resp = self
            .client
            .post(format!("{}/_telium/v1/media", self.base))
            .bearer_auth(token)
            .header("content-type", "image/png")
            .header("x-telium-filename", "pic.png")
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        resp.json::<Value>().await.unwrap()["hash"].as_str().unwrap().to_string()
    }
}

type Transcript = Vec<(String, String)>;

fn step(t: &mut Transcript, label: impl Into<String>, value: impl std::fmt::Display) {
    t.push((label.into(), value.to_string()));
}

#[track_caller]
fn identical(local: &Transcript, remote: &Transcript, want: &[&str]) {
    let required: Transcript = local.iter().zip(want).map(|((l, _), w)| (l.clone(), w.to_string())).collect();
    assert_eq!(local.len(), want.len(), "scenario length changed: {local:?}");
    assert_eq!(local, &required, "the local member got the wrong answer");
    assert_eq!(remote, &required, "the remote member was treated differently from the local one");
}

struct Cast {
    owner: String,
    owner_id: String,
    bystander: String,
    bystander_id: String,
    senior: String,
    senior_id: String,
}

struct Arena {
    guild: String,
    open: String,
    greeting: String,
    hidden: String,
    invite: String,
    owner: String,
    owner_id: String,
    bystander: String,
    bystander_id: String,
    senior_id: String,
    senior_role: String,
    subject_role: String,
    junior_role: String,
    subject: String,
    subject_id: String,
}

async fn cast_on(b: &Server) -> Cast {
    b.register("operator").await;
    let owner = b.register("owner").await;
    let bystander = b.register("bystander").await;
    let senior = b.register("senior").await;
    Cast {
        owner: b.local_session(&owner.token).await,
        owner_id: owner.user_id,
        bystander: b.local_session(&bystander.token).await,
        bystander_id: bystander.user_id,
        senior: b.local_session(&senior.token).await,
        senior_id: senior.user_id,
    }
}

async fn arena(b: &Server, cast: &Cast, name: &str, subject: String, subject_id: String) -> Arena {
    let owner = cast.owner.as_str();
    let (guild, open) = b.guild(owner, name).await;
    let hidden = b.ok("POST", &format!("/guilds/{guild}/channels"), owner, json!({ "name": "back-room", "type": "text" })).await;
    let hidden = hidden["id"].as_str().unwrap().to_string();
    let deny_view = json!({ "allow": "0", "deny": perms::VIEW_CHANNEL.to_string() });
    b.ok("PUT", &format!("/channels/{hidden}/overwrites/role/{guild}"), owner, deny_view).await;
    let mut roles = Vec::new();
    for n in ["senior", "subject", "junior"] {
        let role = b.ok("POST", &format!("/guilds/{guild}/roles"), owner, json!({ "name": n, "permissions": [] })).await;
        roles.push(role["id"].as_str().unwrap().to_string());
    }
    let invite = b.ok("POST", &format!("/guilds/{guild}/invites"), owner, json!({})).await["code"].as_str().unwrap().to_string();
    for token in [&cast.bystander, &cast.senior, &subject] {
        b.ok("POST", &format!("/invites/{invite}/join"), token, json!({})).await;
    }
    for (who, role) in [(&cast.senior_id, &roles[0]), (&subject_id, &roles[1])] {
        b.ok("PATCH", &format!("/guilds/{guild}/members/{who}"), owner, json!({ "add_roles": [role] })).await;
    }
    let listed = b.ok("GET", &format!("/guilds/{guild}/roles"), owner, Value::Null).await;
    let position = |id: &str| listed["roles"].as_array().unwrap().iter().find(|r| r["id"] == id).unwrap()["position"].as_i64().unwrap();
    assert!(position(&roles[0]) > position(&roles[1]) && position(&roles[1]) > position(&roles[2]), "{listed}");
    let greeting = b.say(owner, &open, "welcome in").await;
    let [senior_role, subject_role, junior_role] = <[String; 3]>::try_from(roles).unwrap();
    Arena {
        guild,
        open,
        greeting,
        hidden,
        invite,
        owner: cast.owner.clone(),
        owner_id: cast.owner_id.clone(),
        bystander: cast.bystander.clone(),
        bystander_id: cast.bystander_id.clone(),
        senior_id: cast.senior_id.clone(),
        senior_role,
        subject_role,
        junior_role,
        subject,
        subject_id,
    }
}

async fn arenas(a: &Server, b: &Server) -> (Arena, Arena) {
    let cast = cast_on(b).await;
    a.register("operator").await;
    let here = b.register("subject").await;
    let there = a.register("subject").await;
    let local = arena(b, &cast, "Local member", b.local_session(&here.token).await, here.user_id).await;
    let remote = arena(b, &cast, "Remote member", a.session_on(&there.token, b).await, there.user_id).await;
    (local, remote)
}

async fn grant(b: &Server, ar: &Arena, names: &[&str]) {
    let path = format!("/guilds/{}/roles/{}", ar.guild, ar.subject_role);
    b.ok("PATCH", &path, &ar.owner, json!({ "permissions": names })).await;
}

macro_rules! parity {
    ($scenario:ident, $want:expr) => {{
        let (a, b) = pair().await;
        let (local, remote) = arenas(&a, &b).await;
        let l = $scenario(&b, &local).await;
        let r = $scenario(&b, &remote).await;
        identical(&l, &r, $want);
    }};
}

async fn a_plain_member(b: &Server, ar: &Arena) -> Transcript {
    let mut t = Transcript::new();
    let (g, subj, other) = (&ar.guild, ar.subject.as_str(), &ar.bystander_id);
    let null = Value::Null;
    for (label, method, path, body) in [
        ("rename the guild", "PATCH", format!("/guilds/{g}"), json!({ "name": "mine now" })),
        ("create a channel", "POST", format!("/guilds/{g}/channels"), json!({ "name": "mine" })),
        ("create a role", "POST", format!("/guilds/{g}/roles"), json!({ "name": "mine" })),
        (
            "write oneself an overwrite",
            "PUT",
            format!("/channels/{}/overwrites/member/{}", ar.open, ar.subject_id),
            json!({ "allow": perms::MANAGE_MESSAGES.to_string(), "deny": "0" }),
        ),
        ("read the ban list", "GET", format!("/guilds/{g}/bans"), null.clone()),
        ("read the audit log", "GET", format!("/guilds/{g}/audit-log"), null.clone()),
        ("bulk-delete messages", "POST", format!("/guilds/{g}/moderation/purge"), json!({ "user_id": other })),
        ("add an emoji", "POST", format!("/guilds/{g}/emojis"), json!({ "name": "mine", "data": "" })),
        ("rename another member", "PATCH", format!("/guilds/{g}/members/{other}"), json!({ "nickname": "renamed" })),
        ("hand out a role", "PATCH", format!("/guilds/{g}/members/{other}"), json!({ "add_roles": [ar.junior_role] })),
        ("kick", "DELETE", format!("/guilds/{g}/members/{other}"), null.clone()),
        ("ban", "PUT", format!("/guilds/{g}/bans/{other}"), json!({ "reason": "because" })),
        ("take ownership", "POST", format!("/guilds/{g}/transfer-ownership"), json!({ "user_id": ar.subject_id })),
        ("delete the guild", "DELETE", format!("/guilds/{g}"), null.clone()),
    ] {
        step(&mut t, label, b.st(method, &path, subj, body).await);
    }

    let read = format!("/channels/{}/messages", ar.hidden);
    let hi = json!({ "content": "hi" });
    step(&mut t, "read a hidden channel", b.st("GET", &read, subj, null.clone()).await);
    step(&mut t, "speak in a hidden channel", b.st("POST", &read, subj, hi.clone()).await);
    let allow = perms::VIEW_CHANNEL | perms::SEND_MESSAGES | perms::READ_MESSAGE_HISTORY;
    let admit = json!({ "allow": allow.to_string(), "deny": "0" });
    b.ok("PUT", &format!("/channels/{}/overwrites/role/{}", ar.hidden, ar.subject_role), &ar.owner, admit).await;
    step(&mut t, "read it once the role is admitted", b.st("GET", &read, subj, null.clone()).await);
    step(&mut t, "speak once the role is admitted", b.st("POST", &read, subj, hi.clone()).await);
    let shut = json!({ "allow": "0", "deny": perms::VIEW_CHANNEL.to_string() });
    b.ok("PUT", &format!("/channels/{}/overwrites/member/{}", ar.hidden, ar.subject_id), &ar.owner, shut).await;
    step(&mut t, "read it after a member deny", b.st("GET", &read, subj, null.clone()).await);
    step(&mut t, "speak after a member deny", b.st("POST", &read, subj, hi).await);

    let delete_from = |author: &str, words: &'static str| {
        let (author, open) = (author.to_string(), ar.open.clone());
        async move {
            let id = b.say(&author, &open, words).await;
            b.st("DELETE", &format!("/channels/{open}/messages/{id}"), subj, Value::Null).await
        }
    };
    step(&mut t, "delete another's message", delete_from(&ar.bystander, "keep").await);
    step(&mut t, "delete one's own message", delete_from(subj, "mine").await);
    grant(b, ar, &["MANAGE_MESSAGES"]).await;
    step(&mut t, "delete another's message with MANAGE_MESSAGES", delete_from(&ar.bystander, "again").await);
    grant(b, ar, &[]).await;
    step(&mut t, "delete another's message once it is taken back", delete_from(&ar.bystander, "more").await);

    let me = b.me(g, subj).await;
    step(&mut t, "reported permissions", me["permissions"].as_str().unwrap());
    step(&mut t, "is_owner", &me["is_owner"]);
    step(&mut t, "roles held", me["roles"].as_array().unwrap().len());
    step(&mut t, "top role position", &me["top_role_position"]);
    grant(b, ar, &["MANAGE_MESSAGES", "VIEW_AUDIT_LOG"]).await;
    step(&mut t, "reported permissions after a grant", b.me(g, subj).await["permissions"].as_str().unwrap());
    let channels = b.ok("GET", &format!("/guilds/{g}/channels"), subj, null).await;
    step(&mut t, "channels shown", channels["channels"].as_array().unwrap().len());
    t
}

async fn the_hierarchy(b: &Server, ar: &Arena) -> Transcript {
    let mut t = Transcript::new();
    let (g, subj) = (&ar.guild, ar.subject.as_str());
    grant(b, ar, &["MANAGE_ROLES"]).await;
    let member = format!("/guilds/{g}/members/{}", ar.bystander_id);
    for (label, role) in [("above", &ar.senior_role), ("equal to", &ar.subject_role), ("below", &ar.junior_role)] {
        step(&mut t, format!("hand out a role {label} one's own"), b.st("PATCH", &member, subj, json!({ "add_roles": [role] })).await);
    }
    for (label, role, body) in [
        ("edit a role above one's own", &ar.senior_role, json!({ "name": "mine now" })),
        ("write ADMINISTRATOR onto one's own role", &ar.subject_role, json!({ "permissions": ["ADMINISTRATOR"] })),
        ("edit a role below one's own", &ar.junior_role, json!({ "name": "renamed" })),
    ] {
        step(&mut t, label, b.st("PATCH", &format!("/guilds/{g}/roles/{role}"), subj, body).await);
    }
    step(&mut t, "take back a lower role", b.st("PATCH", &member, subj, json!({ "remove_roles": [ar.junior_role] })).await);

    grant(b, ar, &["KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS"]).await;
    let later = telium_server::util::now_ms() + 600_000;
    for (who, id) in [("a higher role", &ar.senior_id), ("the owner", &ar.owner_id), ("a roleless member", &ar.bystander_id)] {
        let path = format!("/guilds/{g}/members/{id}");
        step(&mut t, format!("time out {who}"), b.st("PATCH", &path, subj, json!({ "timeout_until": later })).await);
        if id != &ar.bystander_id {
            let ban = format!("/guilds/{g}/bans/{id}");
            step(&mut t, format!("ban {who}"), b.st("PUT", &ban, subj, json!({ "reason": "because" })).await);
        }
        step(&mut t, format!("kick {who}"), b.st("DELETE", &path, subj, Value::Null).await);
    }
    t
}

async fn sanctions(b: &Server, ar: &Arena) -> Transcript {
    let mut t = Transcript::new();
    let (g, subj) = (&ar.guild, ar.subject.as_str());
    let member = format!("/guilds/{g}/members/{}", ar.subject_id);
    let messages = format!("/channels/{}/messages", ar.open);
    let later = telium_server::util::now_ms() + 600_000;
    let hello = json!({ "content": "hello" });
    let null = Value::Null;

    step(&mut t, "timed out", b.st("PATCH", &member, &ar.owner, json!({ "timeout_until": later })).await);
    step(&mut t, "read while timed out", b.st("GET", &messages, subj, null.clone()).await);
    step(&mut t, "speak while timed out", b.st("POST", &messages, subj, hello.clone()).await);
    let react = format!("/messages/{}/reactions/%F0%9F%91%8D/@me", ar.greeting);
    step(&mut t, "react while timed out", b.st("PUT", &react, subj, json!({})).await);
    step(&mut t, "timeout lifted", b.st("PATCH", &member, &ar.owner, json!({ "timeout_until": 0 })).await);
    step(&mut t, "speak once lifted", b.st("POST", &messages, subj, hello.clone()).await);

    grant(b, ar, &["KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS", "MANAGE_ROLES", "MANAGE_GUILD"]).await;
    step(&mut t, "moderator timed out", b.st("PATCH", &member, &ar.owner, json!({ "timeout_until": later })).await);
    step(&mut t, "reported permissions while timed out", b.me(g, subj).await["permissions"].as_str().unwrap());
    let other = format!("/guilds/{g}/members/{}", ar.bystander_id);
    for (label, method, path, body) in [
        ("kick while timed out", "DELETE", other.clone(), null.clone()),
        ("ban while timed out", "PUT", format!("/guilds/{g}/bans/{}", ar.bystander_id), json!({ "reason": "muted" })),
        ("time out another while timed out", "PATCH", other, json!({ "timeout_until": later })),
        ("mint a role while timed out", "POST", format!("/guilds/{g}/roles"), json!({ "name": "muted" })),
        ("rename the guild while timed out", "PATCH", format!("/guilds/{g}"), json!({ "name": "muted" })),
        ("invite while timed out", "POST", format!("/guilds/{g}/invites"), json!({})),
    ] {
        step(&mut t, label, b.st(method, &path, subj, body).await);
    }
    b.ok("PATCH", &member, &ar.owner, json!({ "timeout_until": 0 })).await;

    let ban = format!("/guilds/{g}/bans/{}", ar.subject_id);
    let join = format!("/invites/{}/join", ar.invite);
    step(&mut t, "banned", b.st("PUT", &ban, &ar.owner, json!({ "reason": "parity" })).await);
    step(&mut t, "read while banned", b.st("GET", &messages, subj, null.clone()).await);
    step(&mut t, "speak while banned", b.st("POST", &messages, subj, hello.clone()).await);
    step(&mut t, "look at the guild while banned", b.st("GET", &format!("/guilds/{g}"), subj, null.clone()).await);
    step(&mut t, "rejoin while banned", b.st("POST", &join, subj, json!({})).await);
    step(&mut t, "unbanned", b.st("DELETE", &ban, &ar.owner, null.clone()).await);
    step(&mut t, "rejoin once unbanned", b.st("POST", &join, subj, json!({})).await);
    step(&mut t, "speak once back", b.st("POST", &messages, subj, hello.clone()).await);

    step(&mut t, "leave", b.st("POST", &format!("/guilds/{g}/leave"), subj, json!({})).await);
    step(&mut t, "look at the guild after leaving", b.st("GET", &format!("/guilds/{g}"), subj, null.clone()).await);
    step(&mut t, "read after leaving", b.st("GET", &messages, subj, null.clone()).await);
    step(&mut t, "speak after leaving", b.st("POST", &messages, subj, hello).await);
    step(&mut t, "list members after leaving", b.st("GET", &format!("/guilds/{g}/members"), subj, null).await);
    t
}

#[tokio::test]
async fn a_remote_plain_member_is_gated_exactly_like_a_local_one() {
    let everyone = perms::DEFAULT_EVERYONE.to_string();
    let after = (perms::DEFAULT_EVERYONE | perms::MANAGE_MESSAGES | perms::VIEW_AUDIT_LOG).to_string();
    let mut want = vec!["403"; 14];
    want.extend(["404", "404", "200", "200", "404", "404"]);
    want.extend(["403", "200", "200", "403"]);
    want.extend([everyone.as_str(), "false", "2", "2", after.as_str(), "1"]);
    parity!(a_plain_member, &want);
}

#[tokio::test]
async fn a_remote_member_is_held_to_the_role_hierarchy_exactly_like_a_local_one() {
    let want = ["403", "403", "200", "403", "403", "200", "200", "403", "403", "403", "403", "403", "403", "200", "200"];
    parity!(the_hierarchy, &want);
}

#[tokio::test]
async fn a_remote_member_is_timed_out_banned_and_let_go_exactly_like_a_local_one() {
    let allowed = perms::TIMEOUT_ALLOWED.to_string();
    let mut want = vec!["200", "200", "403", "403", "200", "200", "200", allowed.as_str()];
    want.extend(["403"; 6]);
    want.extend(["200", "403", "403", "403", "403", "200", "200", "200"]);
    want.extend(["200", "403", "403", "403", "403"]);
    parity!(sanctions, &want);
}

async fn what_an_owner_can_do(b: &Server, guild: &str, channel: &str, owner: &str, cast: &Cast) -> Transcript {
    let mut t = Transcript::new();
    b.invite_in(guild, owner, &cast.bystander).await;
    let me = b.me(guild, owner).await;
    step(&mut t, "is_owner", &me["is_owner"]);
    step(&mut t, "reported permissions", me["permissions"].as_str().unwrap());
    step(&mut t, "roles held", me["roles"].as_array().unwrap().len());
    let theirs = b.say(&cast.bystander, channel, "not the owner's").await;
    step(&mut t, "delete another's message", b.st("DELETE", &format!("/channels/{channel}/messages/{theirs}"), owner, Value::Null).await);
    step(&mut t, "read the audit log", b.st("GET", &format!("/guilds/{guild}/audit-log"), owner, Value::Null).await);
    let (status, role) =
        b.call("POST", &format!("/guilds/{guild}/roles"), owner, json!({ "name": "admins", "permissions": ["ADMINISTRATOR"] })).await;
    step(&mut t, "mint ADMINISTRATOR", status);
    let member = format!("/guilds/{guild}/members/{}", cast.bystander_id);
    step(&mut t, "hand it out", b.st("PATCH", &member, owner, json!({ "add_roles": [role["id"]] })).await);
    step(&mut t, "kick that administrator", b.st("DELETE", &member, owner, Value::Null).await);
    step(&mut t, "delete the guild", b.st("DELETE", &format!("/guilds/{guild}"), owner, Value::Null).await);
    t
}

#[tokio::test]
async fn a_guild_owner_on_another_homeserver_owns_it_exactly_as_much() {
    let (a, b) = pair().await;
    let cast = cast_on(&b).await;
    a.register("operator").await;
    let here = b.local_session(&b.register("monarch").await.token).await;
    let there = a.session_on(&a.register("monarch").await.token, &b).await;
    let mut transcripts = Vec::new();
    for (owner, name) in [(here, "Owned from here"), (there, "Owned from elsewhere")] {
        let (guild, channel) = b.guild(&owner, name).await;
        transcripts.push(what_an_owner_can_do(&b, &guild, &channel, &owner, &cast).await);
    }
    let max = u64::MAX.to_string();
    identical(&transcripts[0], &transcripts[1], &["true", max.as_str(), "1", "200", "200", "200", "200", "200", "200"]);
}

#[tokio::test]
async fn a_remote_namesake_who_owns_a_guild_at_home_is_an_ordinary_member_here() {
    let (a, b) = pair().await;
    let cast = cast_on(&b).await;
    a.register("operator").await;
    let impostor = a.register("owner").await;
    let at_home = a.local_session(&impostor.token).await;
    let (home_guild, _) = a.guild(&at_home, "Theirs at home").await;
    assert_eq!(a.me(&home_guild, &at_home).await["permissions"], u64::MAX.to_string());

    let (guild, _) = b.guild(&cast.owner, "Not up for grabs").await;
    let visiting = a.session_on(&impostor.token, &b).await;
    b.invite_in(&guild, &cast.owner, &visiting).await;
    let info = b.ok("GET", &format!("/guilds/{guild}"), &visiting, Value::Null).await;
    assert_eq!(info["owner"], cast.owner_id);
    assert_eq!(info["me"]["is_owner"], false, "a namesake was told it owns the guild");
    assert_eq!(info["me"]["permissions"], perms::DEFAULT_EVERYONE.to_string(), "authority leaked across servers");
    for (what, method, path, body) in [
        ("delete the guild", "DELETE", format!("/guilds/{guild}"), Value::Null),
        ("take ownership", "POST", format!("/guilds/{guild}/transfer-ownership"), json!({ "user_id": impostor.user_id })),
        ("kick the owner", "DELETE", format!("/guilds/{guild}/members/{}", cast.owner_id), Value::Null),
        ("mint a role", "POST", format!("/guilds/{guild}/roles"), json!({ "name": "mine" })),
        ("read the audit log", "GET", format!("/guilds/{guild}/audit-log"), Value::Null),
    ] {
        assert_eq!(b.st(method, &path, &visiting, body).await, 403, "a remote namesake could {what}");
    }
}

const CONTROL_PLANE: &[(&str, &str)] = &[
    ("GET", "/admin/status"),
    ("GET", "/admin/version"),
    ("GET", "/admin/step-up"),
    ("POST", "/admin/step-up"),
    ("GET", "/admin/audit"),
    ("GET", "/admin/health"),
    ("GET", "/admin/continuity"),
    ("GET", "/admin/accounts"),
    ("GET", "/admin/accounts/@no-such-account:b.test"),
    ("POST", "/admin/accounts/@no-such-account:b.test/suspend"),
    ("POST", "/admin/accounts/@no-such-account:b.test/reinstate"),
    ("GET", "/admin/guilds"),
    ("GET", "/admin/guilds/{guild}"),
    ("GET", "/admin/metrics"),
    ("GET", "/admin/metrics/series"),
    ("GET", "/admin/storage"),
    ("POST", "/admin/storage/sweep"),
    ("GET", "/admin/moderation/summary"),
    ("GET", "/admin/peers"),
    ("GET", "/admin/peers/a.test"),
    ("GET", "/admin/reports"),
    ("PATCH", "/admin/reports/nonexistent"),
    ("GET", "/admin/defederation"),
    ("POST", "/admin/defederation"),
    ("DELETE", "/admin/defederation/blocked.test"),
    ("GET", "/admin/blocklist-feeds"),
    ("POST", "/admin/blocklist-feeds/refresh"),
    ("GET", "/admin/hosting-catalogs"),
    ("POST", "/admin/hosting-catalogs/refresh"),
    ("POST", "/admin/media/curator-key/rotate"),
    ("POST", "/admin/revalidate"),
    ("POST", "/admin/archive"),
    ("POST", "/admin/guilds/{guild}/purge"),
    ("POST", "/admin/standby/a.test/promote"),
    ("POST", "/admin/sunset"),
    ("POST", "/admin/sunset/execute"),
    ("POST", "/admin/sunset/finalize"),
    ("POST", "/admin/failover"),
    ("POST", "/admin/failover/server/b.test/promote"),
];

fn body_for(method: &str, path: &str) -> Value {
    match (method, path) {
        ("GET" | "DELETE", _) => Value::Null,
        (_, "/admin/defederation") => json!({ "domain": "blocked.test", "scope": "all", "reason": "test" }),
        (_, "/admin/step-up") => json!({ "password": PASSWORD }),
        (_, "/admin/accounts/@no-such-account:b.test/suspend") => json!({ "reason": "test" }),
        (_, "/admin/reports/nonexistent") => json!({ "status": "resolved" }),
        (_, "/admin/sunset") => json!({ "mode": "shutdown" }),
        (_, "/admin/sunset/finalize") => json!({ "confirm": "not-this-server" }),
        (_, "/admin/failover") => json!({ "subject_type": "server", "subject_id": "b.test", "standby": "a.test" }),
        _ => json!({}),
    }
}

async fn operator_and_guild_owner(b: &Server) -> (Account, Account, String) {
    let operator = b.register("operator").await;
    let owner = b.register("owner").await;
    let (guild, _) = b.guild(&b.local_session(&owner.token).await, "Theirs").await;
    (operator, owner, guild)
}

#[tokio::test]
async fn only_the_elevated_operators_home_credential_opens_the_control_plane() {
    let (a, b) = pair().await;
    let (operator, owner, guild) = operator_and_guild_owner(&b).await;
    let guild_session = b.local_session(&operator.token).await;
    let foreign_root = a.register("operator").await;
    assert_eq!(a.st("GET", "/admin/status", &foreign_root.token, Value::Null).await, 200);
    let visiting = a.session_on(&foreign_root.token, &b).await;
    for (method, path) in CONTROL_PLANE {
        let path = path.replace("{guild}", &guild);
        for (who, token, want) in [
            ("a guild owner", owner.token.as_str(), 403),
            ("the operator's guild session", guild_session.as_str(), 401),
            ("another server's operator, visiting", visiting.as_str(), 401),
            ("another server's home token", foreign_root.token.as_str(), 401),
        ] {
            assert_eq!(b.st(method, &path, token, body_for(method, &path)).await, want, "{who}: {method} {path}");
        }
    }
    b.elevate(&operator.token).await;
    for (method, path) in CONTROL_PLANE {
        let path = path.replace("{guild}", &guild);
        assert_ne!(b.st(method, &path, &operator.token, body_for(method, &path)).await, 403, "operator refused {method} {path}");
    }
}

#[tokio::test]
async fn running_the_server_grants_nothing_inside_somebody_elses_guild() {
    let (_a, b) = pair().await;
    let (operator, owner, guild) = operator_and_guild_owner(&b).await;
    assert_eq!(b.ok("GET", "/whoami", &operator.token, Value::Null).await["admin"], true);
    assert_eq!(b.ok("GET", "/whoami", &owner.token, Value::Null).await["admin"], false, "owning a guild made a server admin");
    let theirs = b.local_session(&owner.token).await;
    let mine = b.local_session(&operator.token).await;
    let channel = b.ok("GET", &format!("/guilds/{guild}/channels"), &theirs, Value::Null).await["channels"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let null = Value::Null;

    let message = b.say(&theirs, &channel, "private to this guild").await;
    for (what, method, path, body) in [
        ("look at the guild", "GET", format!("/guilds/{guild}"), null.clone()),
        ("list its channels", "GET", format!("/guilds/{guild}/channels"), null.clone()),
        ("list its members", "GET", format!("/guilds/{guild}/members"), null.clone()),
        ("read a channel", "GET", format!("/channels/{channel}/messages"), null.clone()),
        ("speak", "POST", format!("/channels/{channel}/messages"), json!({ "content": "hi" })),
        ("delete a message", "DELETE", format!("/channels/{channel}/messages/{message}"), null.clone()),
        ("read the audit log", "GET", format!("/guilds/{guild}/audit-log"), null.clone()),
        ("delete the guild", "DELETE", format!("/guilds/{guild}"), null.clone()),
    ] {
        assert_eq!(b.st(method, &path, &mine, body).await, 403, "an operator who never joined could {what}");
    }
    let listed = b.ok("GET", "/guilds", &mine, null.clone()).await;
    assert!(listed["guilds"].as_array().unwrap().is_empty(), "{listed}");

    b.invite_in(&guild, &theirs, &mine).await;
    let me = b.me(&guild, &mine).await;
    assert_eq!(me["permissions"], perms::DEFAULT_EVERYONE.to_string());
    assert_eq!(me["is_owner"], false);
    let message = b.say(&theirs, &channel, "not the operator's").await;
    let owner_member = format!("/guilds/{guild}/members/{}", owner.user_id);
    for (what, method, path, body) in [
        ("delete a message", "DELETE", format!("/channels/{channel}/messages/{message}"), null.clone()),
        ("rename the guild", "PATCH", format!("/guilds/{guild}"), json!({ "name": "seized" })),
        ("mint a role", "POST", format!("/guilds/{guild}/roles"), json!({ "name": "mine" })),
        ("create a channel", "POST", format!("/guilds/{guild}/channels"), json!({ "name": "mine" })),
        ("read the audit log", "GET", format!("/guilds/{guild}/audit-log"), null.clone()),
        ("read the ban list", "GET", format!("/guilds/{guild}/bans"), null.clone()),
        ("kick the owner", "DELETE", owner_member, null.clone()),
        ("ban the owner", "PUT", format!("/guilds/{guild}/bans/{}", owner.user_id), json!({ "reason": "I run it" })),
        ("take ownership", "POST", format!("/guilds/{guild}/transfer-ownership"), json!({ "user_id": operator.user_id })),
        ("delete the guild", "DELETE", format!("/guilds/{guild}"), null.clone()),
    ] {
        assert_eq!(b.st(method, &path, &mine, body).await, 403, "a joined operator could {what}");
    }
    assert_eq!(b.ok("GET", &format!("/guilds/{guild}"), &theirs, null).await["owner"], owner.user_id);
}

#[tokio::test]
async fn takedowns_purges_and_defederation_are_the_operators_alone() {
    let (a, b) = pair().await;
    let (operator, owner, guild) = operator_and_guild_owner(&b).await;
    let uploader = b.register("uploader").await;
    let first = b.upload(&uploader.token, b"bytes one").await;
    assert_eq!(b.st("DELETE", &format!("/media/{first}"), &owner.token, Value::Null).await, 403, "a guild owner took down an upload");
    assert_eq!(b.st("DELETE", &format!("/media/{first}"), &operator.token, Value::Null).await, 200);
    let second = b.upload(&uploader.token, b"bytes two").await;
    assert_eq!(b.st("DELETE", &format!("/media/{second}"), &uploader.token, Value::Null).await, 200);

    b.elevate(&operator.token).await;
    let purge = format!("/admin/guilds/{guild}/purge");
    assert_eq!(b.st("POST", &purge, &operator.token, json!({})).await, 409, "a live guild was purged");
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) VALUES ('guild', ?, 'moved', ?, '{}', 0)",
    )
    .bind(&guild)
    .bind(format!("{guild}@c.test"))
    .execute(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(b.st("POST", &purge, &owner.token, json!({})).await, 403);
    assert_eq!(b.st("POST", &purge, &operator.token, json!({})).await, 200);

    let alice = a.register("alice").await;
    let block = json!({ "domain": "a.test", "scope": "all", "reason": "operator decision" });
    assert_eq!(b.st("POST", "/admin/defederation", &owner.token, block.clone()).await, 403);
    assert_eq!(b.st("POST", "/admin/defederation", &operator.token, block).await, 200);
    let assertion = a.ok("POST", "/assertions", &alice.token, json!({ "audience": "b.test" })).await;
    let refused = b.st("POST", "/sessions", "", json!({ "assertion": assertion["assertion"] })).await;
    assert_eq!(refused, 403, "defederation did not refuse the session");
    assert_eq!(b.st("DELETE", "/admin/defederation/a.test", &owner.token, Value::Null).await, 403);
    assert_eq!(b.st("DELETE", "/admin/defederation/a.test", &operator.token, Value::Null).await, 200);
}
