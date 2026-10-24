use super::*;

#[tokio::test]
async fn a_claim_stops_answering_a_bundle_that_keeps_failing() {
    let (a, b) = pair().await;
    let _victim = b.register("victim").await;

    let token = "an-import-token-for-a-guild-that-will-not-import";
    let guild_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    sqlx::query(
        "INSERT INTO import_claims \
         (token_hash, subject_type, source, source_id, target_id, created_at, expires_at) \
         VALUES (?, 'guild', 'a.test', ?, '@victim:b.test', 0, ?)",
    )
    .bind(telium_server::util::hash_token(token))
    .bind(guild_id)
    .bind(telium_server::util::now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let push = json!({
        "migration_id": "01ARZ3NDEKTSV4RRFFQ69G5FBB",
        "import_token": token,
        "bundle": {
            "version": 1, "kind": "guild", "subject": guild_id,
            "guild": { "id": guild_id, "name": "doomed" },
            "roles": [{ "nothing_this_server_has": 1 }],
        },
    });

    let mut refusals = Vec::new();
    for _ in 0..7 {
        let sent =
            telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/migrate/import", &push)
                .await;
        refusals.push(match sent {
            Ok(_) => "accepted".to_string(),
            Err(e) => e.to_string(),
        });
    }

    assert!(
        refusals.iter().all(|r| r != "accepted"),
        "a bundle this server cannot store was imported: {refusals:?}"
    );
    assert!(
        refusals.last().unwrap().contains("too many times"),
        "the claim never stopped answering: {refusals:?}"
    );
    let gave_up = refusals.iter().filter(|r| r.contains("too many times")).count();
    assert_eq!(gave_up, 2, "the claim gave up at the wrong point: {refusals:?}");

    let attempts: i64 =
        sqlx::query_scalar("SELECT attempts FROM import_claims WHERE token_hash = ?")
            .bind(telium_server::util::hash_token(token))
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
    assert_eq!(attempts, 5, "attempts kept being counted after the claim gave up");
}

#[tokio::test]
async fn a_bundle_nobody_asked_for_gets_an_ordinary_ceiling() {
    let (a, _b) = pair().await;

    let filler = "x".repeat(8 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;

    let message = format!("{sent:?}");
    assert!(
        message.to_lowercase().contains("too large"),
        "an origin no claim names still got the migration ceiling: {message}"
    );
}

#[tokio::test]
async fn a_bundle_that_was_asked_for_gets_the_migration_ceiling() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let filler = "x".repeat(8 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;

    let message = format!("{sent:?}");
    was_read_to_the_end(&message, "a bundle this server is waiting for");
    assert!(
        !message.to_lowercase().contains("too large"),
        "a bundle this server is waiting for was refused for its size: {message}"
    );
}

#[tokio::test]
async fn a_claim_that_has_run_out_of_tries_stops_buying_the_big_ceiling() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at, attempts) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .bind(telium_server::routes::migrate::MAX_IMPORT_ATTEMPTS)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let filler = "x".repeat(8 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;

    let message = format!("{sent:?}");
    assert!(
        message.to_lowercase().contains("too large"),
        "a claim with no tries left still got the migration ceiling: {message}"
    );
}

#[tokio::test]
async fn only_so_many_oversized_bundles_are_read_at_once() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let held: Vec<_> = (0..telium_server::federation::CONCURRENT_BIG_BODIES)
        .filter_map(|_| b.state.big_bodies.hold_a_permit())
        .collect();
    assert_eq!(
        held.len(),
        telium_server::federation::CONCURRENT_BIG_BODIES,
        "the pool did not fill, so what follows proves nothing"
    );

    let filler = "x".repeat(8 * 1024 * 1024);
    let refused = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;
    let message = format!("{refused:?}");
    assert!(
        message.contains("as many large bundles"),
        "an oversized bundle was read with no permit left to read it under: {message}"
    );

    drop(held);
    let after = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": "x".repeat(8 * 1024 * 1024) } }),
    )
    .await;
    was_read_to_the_end(&format!("{after:?}"), "a permit was not given back");
}

#[tokio::test]
async fn one_peer_cannot_hold_every_slot() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let held = b.state.big_bodies.claim("127.0.0.1").unwrap();

    let filler = "x".repeat(8 * 1024 * 1024);
    let refused = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler.clone() } }),
    )
    .await;
    let message = format!("{refused:?}");
    assert!(
        message.contains("already reading a large bundle from you"),
        "one sender took a second slot while its first was still open: {message}"
    );
    assert!(
        !message.contains("as many large bundles"),
        "the pool was drained by a single sender: {message}"
    );

    drop(held);
    let after = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;
    was_read_to_the_end(&format!("{after:?}"), "a sender that finished was not let back in");
}

#[tokio::test]
async fn naming_a_peer_does_not_take_that_peers_slot() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let held = b.state.big_bodies.claim("a.test").unwrap();

    let filler = "x".repeat(8 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;
    let message = format!("{sent:?}");
    was_read_to_the_end(&message, "a stranger wrote a peer's name in a header");
    assert!(
        !message.contains("large bundle"),
        "a stranger writing a peer's name in a header had that peer's bundle refused: {message}"
    );
    drop(held);
}

fn gist(said: &Said) -> String {
    match said {
        Said::Words(w) => w
            .lines()
            .filter(|l| !l.to_ascii_lowercase().starts_with("date:"))
            .collect::<Vec<_>>()
            .join("\n"),
        other => format!("{other:?}"),
    }
}

#[tokio::test]
async fn a_socket_that_stops_sending_does_not_go_on_holding_the_slot() {
    let (_a, b) = pair().await;
    expecting_from_a(&b).await;

    let idle = dribble(&b.base, None).await;
    let mut during = dribble(&b.base, None).await;
    let refused = anything_said(&mut during).await;
    assert!(
        refused.words().contains("already reading a large bundle"),
        "the idle socket never took the slot, so this test proves nothing: {refused:?}"
    );

    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let mut after = dribble(&b.base, None).await;
    assert_eq!(
        anything_said(&mut after).await,
        Said::Silence,
        "a socket that had sent nothing since it opened still held the slot"
    );
    drop((idle, during, after));
}

#[derive(Debug, PartialEq)]
enum Said {
    Words(String),
    Nothing,
    Silence,
}

impl Said {
    fn words(&self) -> &str {
        match self {
            Said::Words(w) => w,
            _ => "",
        }
    }
}

async fn anything_said(sock: &mut tokio::net::TcpStream) -> Said {
    use tokio::io::AsyncReadExt as _;
    let mut buf = [0u8; 1024];
    match tokio::time::timeout(std::time::Duration::from_secs(1), sock.read(&mut buf)).await {
        Ok(Ok(0)) | Ok(Err(_)) => Said::Nothing,
        Ok(Ok(n)) => Said::Words(String::from_utf8_lossy(&buf[..n]).into_owned()),
        Err(_) => Said::Silence,
    }
}

#[tokio::test]
async fn a_body_that_does_not_call_itself_large_takes_no_slot() {
    let (a, b) = pair().await;
    expecting_from_a(&b).await;

    let small = declaring(&b.base, None, 4 * 1024 * 1024).await;
    let also = declaring(&b.base, None, 4 * 1024 * 1024).await;
    let sent = push_a_bundle(&a).await;
    was_read_to_the_end(&sent, "a request that called itself small took a place");
    assert!(
        !sent.contains("large bundle") && !sent.contains("as many large bundles"),
        "a request that called itself small still took a place kept for a bundle: {sent}"
    );
    drop((small, also));
}

#[tokio::test]
async fn a_body_that_says_it_is_over_the_ceiling_is_refused_before_it_takes_a_place() {
    let (_a, b) = pair().await;
    expecting_from_a(&b).await;

    let mut oversized = declaring(&b.base, None, 500_000_000).await;
    let said = anything_said(&mut oversized).await;
    assert!(
        said.words().contains("413"),
        "a body that declared itself over the ceiling was let in: {said:?}"
    );

    let mut real = dribble(&b.base, None).await;
    assert_eq!(
        anything_said(&mut real).await,
        Said::Silence,
        "the refused body had taken a slot before being refused"
    );
    drop((oversized, real));
}

#[tokio::test]
async fn strangers_cannot_spend_the_permits_a_bundle_needs() {
    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.rate_limit.trusted_proxies = vec!["127.0.0.1".to_string()];
    })
    .await;
    expecting_from_a(&b).await;

    let mut strangers = Vec::new();
    for i in 0..telium_server::federation::CONCURRENT_BIG_BODIES {
        strangers.push(
            declaring_as(
                "z.test",
                &b.base,
                Some(&format!("198.51.100.{i}")),
                100 * 1024 * 1024,
            )
            .await,
        );
    }

    let mut again = declaring_as("z.test", &b.base, Some("198.51.100.0"), 100 * 1024 * 1024).await;
    let said = anything_said(&mut again).await;
    assert!(
        said.words().contains("429"),
        "the strangers took nothing, so this proves nothing about what they took: {said:?}"
    );

    let sent = push_a_bundle(&a).await;
    was_read_to_the_end(&sent, "strangers with nothing to send filled the pool");
    assert!(
        !sent.contains("as many large bundles"),
        "strangers with nothing to send filled the pool a real bundle needs: {sent}"
    );

    assert!(
        said.words().contains("already reading a large bundle"),
        "a stranger was turned away by the permit count rather than by its own place: {said:?}"
    );
    drop((strangers, again));
}

#[tokio::test]
async fn a_declared_length_does_not_say_whether_a_claim_is_waiting() {
    let (_a, expecting) = pair().await;
    expecting_from_a(&expecting).await;
    let (_c, not_expecting) = pair().await;

    let big = 100 * 1024 * 1024;
    let (mut welcome, mut stranger) =
        tokio::join!(declaring(&expecting.base, None, big), declaring(&not_expecting.base, None, big));
    let opened = tokio::join!(anything_said(&mut stranger), anything_said(&mut welcome));
    assert_eq!(
        gist(&opened.0),
        gist(&opened.1),
        "the answer to a declared length told the caller whether a claim was waiting for it",
    );

    let (mut welcome_again, mut stranger_again) =
        tokio::join!(declaring(&expecting.base, None, big), declaring(&not_expecting.base, None, big));
    let asked = tokio::join!(anything_said(&mut stranger_again), anything_said(&mut welcome_again));
    assert!(
        gist(&asked.1).contains("already reading a large bundle"),
        "no place was kept even for the caller this server is expecting, so the comparison below \
         proves nothing: {:?}",
        asked.1
    );
    assert_eq!(
        gist(&asked.0),
        gist(&asked.1),
        "a second socket told the caller whether a place was being kept for the first",
    );

    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
    let cut = tokio::join!(anything_said(&mut stranger), anything_said(&mut welcome));
    assert!(
        gist(&cut.0).contains("HTTP/1.1"),
        "the silent socket was still being waited on, so there is no cutting off to compare: \
         {:?}",
        cut.0
    );
    assert_eq!(
        gist(&cut.0),
        gist(&cut.1),
        "the two callers were cut off differently, which is the gate's answer by another route",
    );
    drop((welcome, stranger, welcome_again, stranger_again));
}

#[tokio::test]
async fn a_full_pool_does_not_say_whether_a_claim_is_waiting() {
    let (a, expecting) = pair().await;
    expecting_from_a(&expecting).await;
    let (_c, not_expecting) = pair().await;

    let permits = telium_server::federation::CONCURRENT_BIG_BODIES;
    let held: Vec<_> = [&expecting, &not_expecting]
        .into_iter()
        .flat_map(|h| (0..permits).filter_map(|_| h.state.big_bodies.hold_a_permit()))
        .collect();
    assert_eq!(held.len(), 2 * permits, "the pools did not fill, so what follows proves nothing");

    let starved = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": "x".repeat(8 * 1024 * 1024) } }),
    )
    .await;
    assert!(
        format!("{starved:?}").contains("as many large bundles"),
        "the pool was not actually full, so the comparison below is between two empty pools: \
         {starved:?}"
    );

    let big = 100 * 1024 * 1024;
    let (mut welcome, mut stranger) = tokio::join!(
        declaring(&expecting.base, None, big),
        declaring(&not_expecting.base, None, big)
    );
    let said = tokio::join!(anything_said(&mut stranger), anything_said(&mut welcome));
    assert_eq!(
        gist(&said.0),
        gist(&said.1),
        "with the pool full, the answer to a declared length told the caller whether a claim was \
         waiting for it",
    );
    drop((held, welcome, stranger));
}

#[tokio::test]
async fn ordinary_federation_traffic_does_not_queue_behind_itself() {
    let (_a, b) = pair().await;
    let mut first = chunked_to(&b.base, "/_telium/v1/report").await;
    let mut second = chunked_to(&b.base, "/_telium/v1/report").await;
    for (which, sock) in [("first", &mut first), ("second", &mut second)] {
        let said = anything_said(sock).await;
        assert!(
            !gist(&said).contains("large bundle"),
            "an ordinary federation request was turned away as a bundle ({which}): {said:?}"
        );
    }
    drop((first, second));
}

#[tokio::test]
async fn a_socket_that_takes_no_slot_is_still_not_waited_on_forever() {
    use tokio::io::AsyncReadExt as _;
    let (_a, b) = pair().await;

    let mut quiet = declaring(&b.base, None, 4 * 1024 * 1024).await;
    let mut sink = [0u8; 512];
    let answered =
        tokio::time::timeout(std::time::Duration::from_secs(6), quiet.read(&mut sink)).await;
    let read = answered.expect("the server was still waiting on a silent socket past the deadline");
    let n = read.expect("the connection failed rather than being closed");
    assert!(
        n == 0 || std::str::from_utf8(&sink[..n]).unwrap_or_default().starts_with("HTTP/1.1"),
        "expected the server to answer or hang up, got {n} bytes of something else"
    );
}
