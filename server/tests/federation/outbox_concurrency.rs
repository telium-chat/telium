use super::*;
use axum::http::StatusCode;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::Duration;

async fn fake_peer(delay: Duration, status: StatusCode) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let served_hits = hits.clone();
    let app = axum::Router::new().fallback(move || {
        let hits = served_hits.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            (status, axum::Json(json!({ "ok": true })))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let serve = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, hits, serve)
}

async fn cache_peer(state: &telium_server::AppState, origin: &str, base: &str) {
    sqlx::query(
        "INSERT INTO remote_servers (origin, api_base, fetched_at) VALUES (?, ?, ?)",
    )
    .bind(origin)
    .bind(base)
    .bind(telium_server::util::now_ms())
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn queue_dm(state: &telium_server::AppState, id: &str, destination: &str, created_at: i64) {
    sqlx::query(
        "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, path, payload, next_attempt_at, created_at) \
         VALUES (?, 'unused-conversation', ?, ?, '/_telium/v1/dm/deliver', '{\"message\":{\"kind\":\"application\"}}', 0, ?)",
    )
    .bind(id)
    .bind(id)
    .bind(destination)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn queue_friend(state: &telium_server::AppState, destination: &str) {
    sqlx::query(
        "INSERT INTO friend_outbox (id, destination, pair, payload, next_attempt_at, created_at) \
         VALUES ('friend-retry', ?, '@alice:a.test|@bob:failed.test', \
         '{\"action\":\"request\",\"from\":\"@alice:a.test\",\"to\":\"@bob:failed.test\"}', 0, 1)",
    )
    .bind(destination)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn wait_hits(hits: &AtomicUsize, wanted: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while hits.load(Ordering::SeqCst) < wanted {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the destination was not contacted");
}

#[tokio::test]
async fn simultaneous_dm_pumps_send_a_due_row_only_once() {
    let (a, _b) = pair().await;
    let (url, hits, serve) = fake_peer(Duration::from_millis(300), StatusCode::OK).await;
    cache_peer(&a.state, "delayed.test", &url).await;
    queue_dm(&a.state, "dm-concurrent", "delayed.test", 1).await;

    let state = a.state.clone();
    let first = tokio::spawn(async move { telium_server::routes::dm::flush_outbox(&state).await });
    wait_hits(&hits, 1).await;
    let state = a.state.clone();
    let second = tokio::spawn(async move { telium_server::routes::dm::flush_outbox(&state).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    })
    .await
    .unwrap();

    assert_eq!(hits.load(Ordering::SeqCst), 1, "same row was sent twice");
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_outbox WHERE id = 'dm-concurrent'")
        .fetch_one(&a.state.pool).await.unwrap();
    assert_eq!(remaining, 0);
    serve.abort();
}

#[tokio::test]
async fn a_slow_dm_destination_does_not_delay_healthy_destinations() {
    let (a, _b) = pair().await;
    let (slow_url, slow_hits, slow_server) = fake_peer(Duration::from_millis(700), StatusCode::OK).await;
    let (fast_url, fast_hits, fast_server) = fake_peer(Duration::ZERO, StatusCode::OK).await;
    cache_peer(&a.state, "slow.test", &slow_url).await;
    cache_peer(&a.state, "fast.test", &fast_url).await;
    queue_dm(&a.state, "slow-row", "slow.test", 1).await;
    queue_dm(&a.state, "fast-row", "fast.test", 2).await;

    let state = a.state.clone();
    let pump = tokio::spawn(async move { telium_server::routes::dm::flush_outbox(&state).await });
    tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_outbox WHERE id = 'fast-row'")
                .fetch_one(&a.state.pool).await.unwrap();
            if remaining == 0 { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("fast destination blocked behind the slow one");

    assert_eq!(fast_hits.load(Ordering::SeqCst), 1);
    assert_eq!(slow_hits.load(Ordering::SeqCst), 1);
    let slow_remains: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_outbox WHERE id = 'slow-row'")
        .fetch_one(&a.state.pool).await.unwrap();
    assert_eq!(slow_remains, 1, "the slow request should still be in progress");
    tokio::time::timeout(Duration::from_secs(3), pump).await.unwrap().unwrap().unwrap();
    slow_server.abort();
    fast_server.abort();
}

#[tokio::test]
async fn simultaneous_friend_pumps_increment_one_retry_and_preserve_backoff() {
    let (a, _b) = pair().await;
    let (url, hits, serve) = fake_peer(Duration::from_millis(250), StatusCode::SERVICE_UNAVAILABLE).await;
    cache_peer(&a.state, "failed.test", &url).await;
    queue_friend(&a.state, "failed.test").await;

    let state = a.state.clone();
    let first = tokio::spawn(async move { telium_server::routes::friends::flush_outbox(&state).await });
    wait_hits(&hits, 1).await;
    let state = a.state.clone();
    let second = tokio::spawn(async move { telium_server::routes::friends::flush_outbox(&state).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
    })
    .await
    .unwrap();

    assert_eq!(hits.load(Ordering::SeqCst), 1, "retry was sent twice");
    let (attempts, due): (i64, i64) =
        sqlx::query_as("SELECT attempts, next_attempt_at FROM friend_outbox WHERE id = 'friend-retry'")
            .fetch_one(&a.state.pool).await.unwrap();
    assert_eq!(attempts, 1);
    assert!(due > telium_server::util::now_ms(), "backoff must delay the next attempt");
    serve.abort();
}
