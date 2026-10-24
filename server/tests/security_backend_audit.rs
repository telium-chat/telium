use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-security-audit-{}-{n}", std::process::id()));
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

    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });

    Server {
        base: format!("http://{addr}"),
        client: reqwest::Client::new(),
        dir,
    }
}

struct User {
    user_id: String,
    home_token: String,
    guild_token: String,
}

impl Server {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn patch(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .patch(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn put(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = self.client.get(format!("{}{path}", self.base));
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn delete(&self, path: &str, token: &str) -> (u16, Value) {
        let resp = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn user(&self, localpart: &str) -> User {
        let (status, registered) = self
            .post(
                "/_telium/v1/register",
                None,
                json!({ "localpart": localpart, "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(status, 200, "register: {registered}");
        let home_token = registered["access_token"].as_str().unwrap().to_string();
        let user_id = registered["user_id"].as_str().unwrap().to_string();

        let (status, session) = self
            .post("/_telium/v1/sessions/local", Some(&home_token), json!({}))
            .await;
        assert_eq!(status, 200, "guild session: {session}");
        User {
            user_id,
            home_token,
            guild_token: session["session_token"].as_str().unwrap().to_string(),
        }
    }

    async fn join(&self, guild_id: &str, owner: &User, member: &User) {
        let (status, invite) = self
            .post(
                &format!("/_telium/v1/guilds/{guild_id}/invites"),
                Some(&owner.guild_token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "invite: {invite}");
        let code = invite["code"].as_str().unwrap();
        let (status, joined) = self
            .post(
                &format!("/_telium/v1/invites/{code}/join"),
                Some(&member.guild_token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "join: {joined}");
    }
}

#[tokio::test]
async fn private_media_metadata_requires_the_same_capability_as_the_bytes() {
    let s = start().await;
    let alice = s.user("alice").await;

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home_token)
        .header("X-Telium-Purpose", "attachment")
        .header("X-Telium-Filename", "audit-secret.txt")
        .header(reqwest::header::CONTENT_TYPE, "text/plain")
        .body(b"security audit fixture".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap();
    let cap = media["capability"].as_str().unwrap();

    let (status, _) = s
        .get(&format!("/_telium/v1/media/{hash}/meta"), None)
        .await;
    assert_eq!(status, 404, "the content hash alone must not disclose metadata");

    let (status, _) = s
        .get(
            &format!("/_telium/v1/media/{hash}/meta?cap=definitely-wrong"),
            None,
        )
        .await;
    assert_eq!(status, 404, "a wrong capability must be indistinguishable from absence");

    let (status, meta) = s
        .get(
            &format!("/_telium/v1/media/{hash}/meta?cap={cap}"),
            None,
        )
        .await;
    assert_eq!(status, 200, "valid capability: {meta}");
    assert_eq!(meta["filename"], "audit-secret.txt");
    assert_eq!(meta["mime"], "text/plain");
    assert_eq!(meta["size"], b"security audit fixture".len() as i64);
}

#[tokio::test]
async fn delegated_role_management_cannot_cross_hierarchy_permissions_or_targets() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let carol = s.user("carol").await;

    let (status, guild) = s
        .post(
            "/_telium/v1/guilds",
            Some(&alice.guild_token),
            json!({ "name": "Security" }),
        )
        .await;
    assert_eq!(status, 200, "guild: {guild}");
    let gid = guild["id"].as_str().unwrap();
    s.join(gid, &alice, &bob).await;
    s.join(gid, &alice, &carol).await;

    let (_, channels) = s
        .get(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.guild_token),
        )
        .await;
    let cid = channels["channels"][0]["id"].as_str().unwrap();

    let (_, high) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&alice.guild_token),
            json!({ "name": "High", "permissions": ["BAN_MEMBERS"] }),
        )
        .await;
    let (_, mid) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&alice.guild_token),
            json!({ "name": "Manager", "permissions": ["MANAGE_ROLES"] }),
        )
        .await;
    let (_, low) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&alice.guild_token),
            json!({ "name": "Low" }),
        )
        .await;
    let high_id = high["id"].as_str().unwrap();
    let mid_id = mid["id"].as_str().unwrap();
    let low_id = low["id"].as_str().unwrap();

    let (status, reordered) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            &alice.guild_token,
            json!({
                "roles": [
                    { "id": high_id, "position": 3 },
                    { "id": mid_id, "position": 2 },
                    { "id": low_id, "position": 1 }
                ]
            }),
        )
        .await;
    assert_eq!(status, 200, "reorder: {reordered}");

    let (status, body) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", bob.user_id),
            &alice.guild_token,
            json!({ "add_roles": [mid_id] }),
        )
        .await;
    assert_eq!(status, 200, "give manager role: {body}");
    let (status, body) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", carol.user_id),
            &alice.guild_token,
            json!({ "add_roles": [high_id, low_id] }),
        )
        .await;
    assert_eq!(status, 200, "seed target roles: {body}");

    let (status, _) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&bob.guild_token),
            json!({ "name": "Escalated", "position": 2 }),
        )
        .await;
    assert_eq!(status, 403, "a manager must not create a role at or above their own");

    let (status, _) = s
        .delete(
            &format!("/_telium/v1/guilds/{gid}/roles/{high_id}"),
            &bob.guild_token,
        )
        .await;
    assert_eq!(status, 403, "MANAGE_ROLES must not delete a role at or above the actor");

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", carol.user_id),
            &bob.guild_token,
            json!({ "remove_roles": [high_id] }),
        )
        .await;
    assert_eq!(status, 403, "MANAGE_ROLES must not strip a role at or above the actor");

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", carol.user_id),
            &bob.guild_token,
            json!({ "remove_roles": [low_id] }),
        )
        .await;
    assert_eq!(status, 403, "role edits on another member require outranking that member");

    let (status, _) = s
        .put(
            &format!("/_telium/v1/channels/{cid}/overwrites/role/{low_id}"),
            &bob.guild_token,
            json!({ "allow": (1u64 << 6).to_string(), "deny": "0" }),
        )
        .await;
    assert_eq!(status, 403, "an overwrite must not grant permission bits the actor lacks");

    let (status, _) = s
        .put(
            &format!("/_telium/v1/channels/{cid}/overwrites/role/{high_id}"),
            &bob.guild_token,
            json!({ "allow": "0", "deny": "0" }),
        )
        .await;
    assert_eq!(status, 403, "overwrite targets must obey role hierarchy");

    let (status, _) = s
        .put(
            &format!("/_telium/v1/channels/{cid}/overwrites/role/does-not-exist"),
            &bob.guild_token,
            json!({ "allow": "0", "deny": "0" }),
        )
        .await;
    assert_eq!(status, 404, "an overwrite cannot name a role outside this guild");

    let (status, _) = s
        .put(
            &format!("/_telium/v1/channels/{cid}/overwrites/member/@nobody:test.example"),
            &bob.guild_token,
            json!({ "allow": "0", "deny": "0" }),
        )
        .await;
    assert_eq!(status, 404, "an overwrite cannot name a non-member");

    let (status, body) = s
        .delete(
            &format!("/_telium/v1/guilds/{gid}/roles/{low_id}"),
            &bob.guild_token,
        )
        .await;
    assert_eq!(status, 200, "a manager should still be able to manage roles below them: {body}");
}
