
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use telium_server::auth::HomeAuth;
use telium_server::gateway::events::Event;
use telium_server::{config::Config, routes::identity, AppState};
use tokio::sync::mpsc::Receiver;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Home {
    state: AppState,
    dir: std::path::PathBuf,
    next_session: u64,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn home() -> Home {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir =
        std::env::temp_dir().join(format!("telium-profile-fanout-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut cfg = Config {
        server_name: "home.example".into(),
        public_base_url: "http://home.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.roles.guild = false;
    let state = telium_server::build_state(cfg).await.unwrap();
    Home { state, dir, next_session: 1 }
}

impl Home {
    async fn account(&self, localpart: &str, display: &str) -> String {
        let user_id = format!("@{localpart}:home.example");
        sqlx::query(
            "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
             VALUES (?, ?, 'home.example', 'hash', 1000)",
        )
        .bind(&user_id)
        .bind(localpart)
        .execute(&self.state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO profiles (user_id, display_name, profile_version, updated_at) \
             VALUES (?, ?, 1, 1000)",
        )
        .bind(&user_id)
        .bind(display)
        .execute(&self.state.pool)
        .await
        .unwrap();
        user_id
    }

    async fn friendship(&self, user_id: &str, peer_id: &str, state: &str) {
        let domain = peer_id.split(':').nth(1).unwrap();
        sqlx::query(
            "INSERT INTO friends (user_id, peer_id, peer_domain, state, created_at, updated_at) \
             VALUES (?, ?, ?, ?, 1000, 1000)",
        )
        .bind(user_id)
        .bind(peer_id)
        .bind(domain)
        .bind(state)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    async fn conversation(&self, id: &str, members: &[&str]) {
        sqlx::query(
            "INSERT INTO conversations (id, kind, sequencer, creator, created_at, updated_at) \
             VALUES (?, 'dm', 'home.example', ?, 1000, 1000)",
        )
        .bind(id)
        .bind(members[0])
        .execute(&self.state.pool)
        .await
        .unwrap();
        for member in members {
            let domain = member.split(':').nth(1).unwrap();
            sqlx::query(
                "INSERT INTO conversation_members \
                 (conversation_id, user_id, home_domain, state, added_at) \
                 VALUES (?, ?, ?, 'active', 1000)",
            )
            .bind(id)
            .bind(member)
            .bind(domain)
            .execute(&self.state.pool)
            .await
            .unwrap();
        }
    }

    async fn connect(&mut self, user_id: &str) -> Receiver<Arc<Event>> {
        let (tx, rx) = tokio::sync::mpsc::channel(telium_server::gateway::hub::OUTBOX_DEPTH);
        let (out, _lagging) = telium_server::gateway::hub::Outbox::new(tx);
        let id = self.next_session;
        self.next_session += 1;
        self.state.hub.subscribe_user(id, user_id, out).await;
        rx
    }

    async fn patch(&self, user_id: &str, patch: Value) {
        let auth = HomeAuth { user_id: user_id.to_string(), device_id: "dev-1".into() };
        let _ = identity::patch_profile(
            State(self.state.clone()),
            auth,
            Json(serde_json::from_value(patch).unwrap()),
        )
        .await
        .unwrap();
    }
}

fn profiles(rx: &mut Receiver<Arc<Event>>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(event) = rx.try_recv() {
        if event.t == "PROFILE_UPDATE" {
            out.push(event.data.clone());
        }
    }
    out
}

#[tokio::test]
async fn a_friend_sharing_no_guild_is_told() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let bob = home.account("bob", "Bob").await;
    home.friendship(&bob, &alice, "accepted").await;
    home.friendship(&alice, &bob, "accepted").await;

    let mut watching = home.connect(&bob).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    let seen = profiles(&mut watching);
    assert_eq!(seen.len(), 1, "one announcement, not one per field");
    assert_eq!(seen[0]["user_id"], alice.as_str());
    assert_eq!(seen[0]["display_name"], "Alice Liddell");
}

#[tokio::test]
async fn the_other_side_of_a_dm_is_told() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let carol = home.account("carol", "Carol").await;
    home.conversation("conv-1", &[&alice, &carol]).await;

    let mut watching = home.connect(&carol).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    let seen = profiles(&mut watching);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["display_name"], "Alice Liddell");
}

#[tokio::test]
async fn the_whole_profile_goes_out_not_just_the_two_fields_a_guild_caches() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let bob = home.account("bob", "Bob").await;
    home.friendship(&bob, &alice, "accepted").await;

    let mut watching = home.connect(&bob).await;
    home.patch(
        &alice,
        json!({
            "bio": "Grows tomatoes.",
            "pronouns": "she/her",
            "banner_ref": "banner-1",
            "accent_color": 3_355_443,
            "avatar_ref": "face-1",
        }),
    )
    .await;

    let seen = profiles(&mut watching);
    assert_eq!(seen.len(), 1);
    let p = &seen[0];
    assert_eq!(p["bio"], "Grows tomatoes.");
    assert_eq!(p["pronouns"], "she/her");
    assert_eq!(p["banner_ref"], "banner-1");
    assert_eq!(p["accent_color"], 3_355_443);
    assert_eq!(p["avatar_ref"], "face-1");
    assert_eq!(p["display_name"], "Alice");
    assert_eq!(p["profile_version"], 2);
    assert_eq!(p["created_at"], 1000);
}

#[tokio::test]
async fn your_own_other_devices_are_told() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;

    let mut laptop = home.connect(&alice).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    let seen = profiles(&mut laptop);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["display_name"], "Alice Liddell");
}

#[tokio::test]
async fn nobody_else_is() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let bob = home.account("bob", "Bob").await;
    let dave = home.account("dave", "Dave").await;
    let erin = home.account("erin", "Erin").await;
    let frank = home.account("frank", "Frank").await;
    home.friendship(&dave, &alice, "pending_out").await;
    home.friendship(&erin, &alice, "blocked").await;
    home.friendship(&alice, &frank, "accepted").await;
    home.conversation("conv-1", &[&bob, &dave]).await;

    let mut strangers = Vec::new();
    for who in [&bob, &dave, &erin, &frank] {
        strangers.push(home.connect(who).await);
    }
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    for mut rx in strangers {
        assert!(profiles(&mut rx).is_empty());
    }
}

#[tokio::test]
async fn a_person_in_both_halves_of_the_audience_is_told_once() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let bob = home.account("bob", "Bob").await;
    home.friendship(&bob, &alice, "accepted").await;
    home.conversation("conv-1", &[&alice, &bob]).await;
    home.conversation("conv-2", &[&alice, &bob]).await;

    let mut watching = home.connect(&bob).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    assert_eq!(profiles(&mut watching).len(), 1);
}

#[tokio::test]
async fn somebody_who_walked_out_of_the_conversation_is_not() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let carol = home.account("carol", "Carol").await;
    home.conversation("conv-1", &[&alice, &carol]).await;
    sqlx::query("UPDATE conversation_members SET state = 'left' WHERE user_id = ?")
        .bind(&carol)
        .execute(&home.state.pool)
        .await
        .unwrap();

    let mut watching = home.connect(&carol).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    assert!(profiles(&mut watching).is_empty());
}

#[tokio::test]
async fn every_device_of_a_watcher_gets_it() {
    let mut home = home().await;
    let alice = home.account("alice", "Alice").await;
    let bob = home.account("bob", "Bob").await;
    home.friendship(&bob, &alice, "accepted").await;

    let mut phone = home.connect(&bob).await;
    let mut laptop = home.connect(&bob).await;
    home.patch(&alice, json!({ "display_name": "Alice Liddell" })).await;

    assert_eq!(profiles(&mut phone).len(), 1);
    assert_eq!(profiles(&mut laptop).len(), 1);
}
