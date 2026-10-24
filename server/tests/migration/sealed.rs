use super::*;

fn sealed_envelope(ct: &str) -> Value {
    json!({ "sealed": "v1", "kid": "AAECAwQFBgc", "iv": "AAECAwQFBgcICQoL", "ct": ct })
}

async fn sync_sealed(pool: &SqlitePool, user_id: &str) -> bool {
    let stamp: Option<i64> = sqlx::query_scalar("SELECT sync_sealed_at FROM accounts WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
    stamp.is_some()
}

#[tokio::test]
async fn sealed_sync_state_moves_as_ciphertext_and_stays_sealed() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let ana = "@ana:a.example";
    account(&a.pool, ana, "ana", "a.example").await;
    sqlx::query("UPDATE accounts SET sync_sealed_at = 1 WHERE user_id = ?")
        .bind(ana)
        .execute(&a.pool)
        .await
        .unwrap();
    let prefs = sealed_envelope("cHJlZnMtY2lwaGVydGV4dA");
    let drafts = sealed_envelope("ZHJhZnRzLWNpcGhlcnRleHQ");
    let stickers = sealed_envelope("c3RpY2tlcnMtY2lwaGVydGV4dA");
    synced(&a.pool, ana, "prefs.v1", prefs.clone()).await;
    synced(&a.pool, ana, "drafts.v2", drafts.clone()).await;
    synced(&a.pool, ana, "stickers.saved.v1", stickers.clone()).await;
    synced(&a.pool, ana, "drafts.v1", json!({ "chan": "UNSENT-DRAFT-PLAINTEXT" })).await;
    synced(&a.pool, ana, "emoji.tone.v1", json!("3")).await;

    let bundle = migration::export_user(&a, ana).await.unwrap();
    assert_eq!(bundle["sync_sealed"], json!(true));
    account(&b.pool, "@ana:b.example", "ana", "b.example").await;
    assert!(!bundle.to_string().contains("UNSENT-DRAFT-PLAINTEXT"));

    import_user(&b, &bundle, "@ana:b.example").await;
    let landed = synced_at(&b.pool, "@ana:b.example").await;
    assert_eq!(
        landed.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["drafts.v2", "prefs.v1", "stickers.saved.v1"]
    );
    assert_eq!(landed["prefs.v1"], prefs);
    assert_eq!(landed["drafts.v2"], drafts);
    assert_eq!(landed["stickers.saved.v1"], stickers);
    assert!(sync_sealed(&b.pool, "@ana:b.example").await);
}

#[tokio::test]
async fn a_bundle_cannot_carry_plaintext_into_a_sealed_sync_store() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    assert_eq!(bundle["sync_sealed"], json!(false));
    let gifs = sealed_envelope("Z2lmcy1jaXBoZXJ0ZXh0");
    bundle["sync_store"] = json!([
        { "key": "gif.favorites.v1", "value": gifs.to_string(), "updated_at": 1 },
        { "key": "prefs.v1", "value": json!({ "theme": "light" }).to_string(), "updated_at": 1 },
        { "key": "drafts.v2", "value": json!({ "c1": "UNSENT" }).to_string(), "updated_at": 1 },
        { "key": "drafts.v1", "value": sealed_envelope("eA").to_string(), "updated_at": 1 },
    ]);

    account(&b.pool, "@ana:b.example", "ana", "b.example").await;
    import_user(&b, &bundle, "@ana:b.example").await;
    let landed = synced_at(&b.pool, "@ana:b.example").await;
    assert_eq!(landed.keys().map(String::as_str).collect::<Vec<_>>(), vec!["gif.favorites.v1"]);
    assert_eq!(landed["gif.favorites.v1"], gifs);
    assert!(sync_sealed(&b.pool, "@ana:b.example").await);

    let c = home("c.example").await;
    bundle["sync_store"] = json!([
        { "key": "prefs.v1", "value": json!({ "theme": "light" }).to_string(), "updated_at": 1 },
    ]);
    account(&c.pool, "@ana:c.example", "ana", "c.example").await;
    import_user(&c, &bundle, "@ana:c.example").await;
    assert_eq!(synced_at(&c.pool, "@ana:c.example").await["prefs.v1"], json!({ "theme": "light" }));
    assert!(!sync_sealed(&c.pool, "@ana:c.example").await);
}
