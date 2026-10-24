//! Manual e2e helper against a running `telium-sfu`: `cargo run --example e2e -- key|session|control <user>`.
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use telium_protocol as proto;

const KEY: [u8; 32] = [7u8; 32];
const KEY_ID: &str = "ed25519:test";
const ORIGIN: &str = "home.example";
const SFU: &str = "http://127.0.0.1:7890";

fn signing() -> SigningKey {
    SigningKey::from_bytes(&KEY)
}

fn join_token() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let claims = json!({
        "kind": "sfu_join",
        "guild": "g1",
        "channel": "c1",
        "user_id": "u1",
        "device_id": "d1",
        "session_id": "s1",
        "origin": ORIGIN,
        "region": "auto",
        "max_bitrate": 64000,
        "flags": { "speak": true, "video": true, "stream": false, "priority": false },
        "issued_at": now,
        "expires_at": now + 120_000,
    });
    let signed = proto::sign_json(&signing(), KEY_ID, claims);
    proto::b64(signed.to_string().as_bytes())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let client = reqwest::Client::new();
    let sfu = std::env::var("SFU_URL").unwrap_or_else(|_| SFU.to_string());
    match args.get(1).map(String::as_str) {
        Some("key") => {
            println!("{}", proto::b64(signing().verifying_key().as_bytes()));
        }
        Some("session") => {
            let resp = client
                .post(format!("{sfu}/session"))
                .json(&json!({ "token": join_token() }))
                .send()
                .await
                .unwrap();
            let v: Value = resp.json().await.unwrap();
            println!("URL={}", v["url"]);
            println!("TOKEN={}", v["token"]);
            println!("ROOM={}", v["room"]);
        }
        Some("control") => {
            let user = args.get(2).cloned().unwrap_or_else(|| "u1".into());
            let action = args.get(3).cloned().unwrap_or_else(|| "disconnect".into());
            let inner = match action.as_str() {
                "mute" => json!({ "command": "mute", "user_id": user, "mute": true }),
                "deafen" => json!({ "command": "deafen", "user_id": user, "deaf": true }),
                _ => json!({ "command": "disconnect", "user_id": user }),
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            let body = proto::sign_json(
                &signing(),
                KEY_ID,
                json!({
                    "origin": ORIGIN,
                    "guild": "g1",
                    "channel": "c1",
                    "issued_at": now,
                    "command": inner,
                }),
            );
            let resp = client
                .post(format!("{sfu}/control"))
                .json(&body)
                .send()
                .await
                .unwrap();
            println!("CONTROL status={}", resp.status());
        }
        _ => println!("usage: e2e <key|session|control [user_id]>"),
    }
}
