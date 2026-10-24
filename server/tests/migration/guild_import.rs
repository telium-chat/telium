use super::*;

#[tokio::test]
async fn a_landed_import_names_its_subject_before_it_is_acknowledged() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();

    let new_id = migration::import_guild(
        &b,
        &bundle,
        "@o:b.example",
        &migration::Reservation {
            migration_id: "m-landed",
            subject_type: "guild",
            source: "a.example",
            source_id: &s.guild,
            token_hash: "",
        },
    )
    .await
    .unwrap();

    let (logged, ack): (String, String) =
        sqlx::query_as("SELECT new_id, ack FROM import_log WHERE id = 'm-landed'")
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert!(ack.is_empty(), "the acknowledgement was written, so this is the wrong state to test");
    assert_eq!(logged, new_id, "the row that survived does not say which guild landed");
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE id = ?")
        .bind(&new_id)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(live, 1, "the log names a guild this server does not have");

    let landed = migration::import_user(
        &b,
        &json!({ "version": 2, "kind": "user", "subject": "@ana:a.example" }),
        "@ana:b.example",
        "a.example",
        &migration::Reservation {
            migration_id: "m-account",
            subject_type: "user",
            source: "a.example",
            source_id: "@ana:a.example",
            token_hash: "",
        },
    )
    .await
    .unwrap();
    let (logged, ack): (String, String) =
        sqlx::query_as("SELECT new_id, ack FROM import_log WHERE id = 'm-account'")
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert!(ack.is_empty(), "the acknowledgement was written, so this is the wrong state to test");
    assert_eq!(logged, landed, "the row that survived does not say which account landed");
}

#[tokio::test]
async fn one_migration_id_cannot_be_imported_under_twice() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();

    let once = migration::Reservation {
        migration_id: "m-once",
        subject_type: "guild",
        source: "a.example",
        source_id: &s.guild,
        token_hash: "",
    };
    migration::import_guild(&b, &bundle, "@ana:b.example", &once).await.unwrap();
    let again =
        migration::import_guild(&b, &bundle, "@ana:b.example", &once).await.unwrap_err();
    let said = format!("{again:?}");
    assert!(
        said.contains("migration id"),
        "a second import under an id already logged was not refused by the id: {said}"
    );

    let elsewhere = migration::import_guild(
        &b,
        &bundle,
        "@ana:b.example",
        &migration::Reservation {
            migration_id: "m-twice",
            subject_type: "guild",
            source: "a.example",
            source_id: &s.guild,
            token_hash: "",
        },
    )
    .await;
    assert!(elsewhere.is_ok(), "the same bundle under another id was refused too: {elsewhere:?}");
}

#[tokio::test]
async fn a_moved_guild_keeps_every_id_it_had() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    assert_eq!(new_guild, s.guild, "the guild's own id is the whole point");

    let mut expected =
        vec![s.channel.clone(), s.category.clone(), s.thread.clone(), s.announce.clone()];
    expected.sort();
    assert_eq!(ids(&b.pool, "channels", &new_guild).await, expected);

    assert_eq!(ids(&b.pool, "stickers", &new_guild).await, vec![s.sticker.clone()]);

    let mut expected = vec![s.role.clone(), s.guild.clone()];
    expected.sort();
    assert_eq!(ids(&b.pool, "roles", &new_guild).await, expected, "@everyone still is the guild id");

    assert_eq!(ids(&b.pool, "emojis", &new_guild).await, vec![s.emoji.clone()]);

    let mut expected = s.messages.clone();
    expected.sort();
    assert_eq!(ids(&b.pool, "messages", &new_guild).await, expected);
}

#[tokio::test]
async fn message_text_names_things_that_exist() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    assert_eq!(dangling(&a.pool, &s.guild).await, vec![s.elsewhere.clone()]);

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    assert_eq!(
        dangling(&b.pool, &new_guild).await,
        vec![s.elsewhere.clone()],
        "a move must not leave a mention or an emoji pointing at nothing"
    );
    assert_eq!(content(&a.pool, &s.guild).await, content(&b.pool, &new_guild).await);
}

#[tokio::test]
async fn the_things_that_point_at_other_things_still_point_at_them() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let parent: Option<String> =
        sqlx::query_scalar("SELECT parent_id FROM channels WHERE id = ?")
            .bind(&s.channel)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(parent.as_deref(), Some(s.category.as_str()));

    let target: String = sqlx::query_scalar(
        "SELECT target_id FROM channel_overwrites WHERE channel_id = ?",
    )
    .bind(&s.channel)
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(target, s.role);

    let role: String = sqlx::query_scalar(
        "SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = '@ana:a.example'",
    )
    .bind(&new_guild)
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(role, s.role);

    let reply: Option<String> = sqlx::query_scalar("SELECT reply_to FROM messages WHERE id = ?")
        .bind(&s.messages[4])
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(reply.as_deref(), Some(s.messages[0].as_str()));
}

#[tokio::test]
async fn a_guild_that_comes_home_is_renumbered_consistently() {
    let a = home("a.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&a, &bundle, "@ana:a.example").await.unwrap();
    assert_ne!(new_guild, s.guild);

    let channels = ids(&a.pool, "channels", &new_guild).await;
    assert_eq!(channels.len(), 4);
    assert!(!channels.contains(&s.channel) && !channels.contains(&s.category));

    let roles = ids(&a.pool, "roles", &new_guild).await;
    assert!(roles.contains(&new_guild), "@everyone follows the guild id");
    assert!(!roles.contains(&s.role));

    let emoji = ids(&a.pool, "emojis", &new_guild).await;
    assert_eq!(emoji.len(), 1);
    assert_ne!(emoji[0], s.emoji);

    let moved = content(&a.pool, &new_guild).await;
    assert!(moved[0].contains(&format!("<partyparrot:{}>", emoji[0])), "got {}", moved[0]);
    assert!(!moved[0].contains(&s.emoji));
    assert!(!moved[0].contains(&s.role));
    assert!(!moved[0].contains(&s.channel));

    let role_id: String = sqlx::query_scalar(
        "SELECT id FROM roles WHERE guild_id = ? AND name = 'mods'",
    )
    .bind(&new_guild)
    .fetch_one(&a.pool)
    .await
    .unwrap();
    assert!(moved[0].contains(&format!("<@&{role_id}>")));

    assert!(moved[1].contains(&format!("<partyparrot:{}@a.example>", emoji[0])), "got {}", moved[1]);
    assert_eq!(dangling(&a.pool, &new_guild).await, vec![s.elsewhere.clone()]);

    let original = content(&a.pool, &s.guild).await;
    assert_eq!(moved[2], original[2]);
    assert_eq!(moved[3], original[3]);
}

async fn stickers_of(pool: &SqlitePool, guild: &str) -> Vec<Value> {
    let raw: Vec<String> = sqlx::query_scalar(
        "SELECT sticker FROM messages WHERE guild_id = ? AND sticker IS NOT NULL ORDER BY id",
    )
    .bind(guild)
    .fetch_all(pool)
    .await
    .unwrap();
    raw.iter().map(|r| serde_json::from_str(r).unwrap()).collect()
}

#[tokio::test]
async fn a_sticker_that_moved_is_asked_for_where_it_lives_now() {
    let a = home("a.example").await;
    let s = seed(&a.pool).await;

    let borrowed = ulid();
    let carrying = ulid();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, sticker, \
         author_signature, created_at) VALUES (?, ?, ?, '@ana:a.example', '', ?, 'sig-zz', 4100)",
    )
    .bind(&carrying)
    .bind(&s.channel)
    .bind(&s.guild)
    .bind(format!("{{\"id\":\"{borrowed}\",\"name\":\"wave\",\"origin\":\"c.example\"}}"))
    .execute(&a.pool)
    .await
    .unwrap();
    index(&a.pool, &carrying, &s.channel, &s.guild, "@ana:a.example", "").await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();

    let b = home("b.example").await;
    let moved = import_guild(&b, &bundle, "@bo:b.example").await.unwrap();
    let there = stickers_of(&b.pool, &moved).await;
    let ours = there.iter().find(|v| v["name"] == "shrug").expect("the guild's own sticker");
    assert_eq!(ours["id"], json!(s.sticker), "an unrenumbered id should not have changed");
    assert_eq!(
        ours["origin"],
        json!("b.example"),
        "the guild moved and its sticker is still being asked of the server it left"
    );
    let theirs = there.iter().find(|v| v["name"] == "wave").expect("the borrowed sticker");
    assert_eq!(theirs["id"], json!(borrowed), "a sticker we do not carry is not ours to renumber");
    assert_eq!(theirs["origin"], json!("c.example"), "nor is it ours to rehome");

    let again = import_guild(&a, &bundle, "@ana:a.example").await.unwrap();
    let back = stickers_of(&a.pool, &again).await;
    let ours = back.iter().find(|v| v["name"] == "shrug").expect("the guild's own sticker");
    assert_ne!(ours["id"], json!(s.sticker), "a renumbered guild's sticker keeps its old id");
    assert_eq!(ours["origin"], json!("a.example"));
    let theirs = back.iter().find(|v| v["name"] == "wave").expect("the borrowed sticker");
    assert_eq!(theirs["id"], json!(borrowed));
    assert_eq!(theirs["origin"], json!("c.example"));
}

#[tokio::test]
async fn an_empty_bundle_still_makes_a_guild() {
    let b = home("b.example").await;
    let bundle = json!({
        "version": migration::BUNDLE_VERSION,
        "kind": "guild",
        "subject": "",
        "guild": { "name": "Rescued" },
    });
    let id = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();
    let name: String = sqlx::query_scalar("SELECT name FROM guilds WHERE id = ?")
        .bind(&id)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(name, "Rescued");
}

const NOT_A_GUILD: &[&str] = &[
    "guild_alias_redirects",
    "automod_hits",
    "media_vouchers",
    "voice_states",
    "notification_inbox",
    "notification_outbox",
    "remote_memberships",
    "ephemeral_messages",
    "interactions",
];

const REACHED_THROUGH: &[(&str, &str)] = &[
    ("channel_overwrites", "JOIN channels c ON c.id = channel_overwrites.channel_id WHERE c.guild_id = ?"),
    ("message_mentions", "JOIN channels c ON c.id = message_mentions.channel_id WHERE c.guild_id = ?"),
    ("pins", "JOIN channels c ON c.id = pins.channel_id WHERE c.guild_id = ?"),
    ("read_state", "JOIN channels c ON c.id = read_state.channel_id WHERE c.guild_id = ?"),
    ("channel_follows", "JOIN channels c ON c.id = channel_follows.source_id WHERE c.guild_id = ?"),
    ("reactions", "JOIN messages m ON m.id = reactions.message_id WHERE m.guild_id = ?"),
];

async fn everything_a_guild_is(pool: &SqlitePool) -> Vec<(String, String)> {
    let named: Vec<String> = sqlx::query_scalar(
        "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p \
         WHERE m.type = 'table' AND p.name = 'guild_id' ORDER BY m.name",
    )
    .fetch_all(pool)
    .await
    .unwrap();

    let mut tables: Vec<(String, String)> = named
        .into_iter()
        .filter(|name| !NOT_A_GUILD.contains(&name.as_str()))
        .map(|name| {
            let scope = if name == "guilds" { "WHERE id = ?" } else { "WHERE guild_id = ?" };
            (name, scope.to_string())
        })
        .collect();
    tables.extend(REACHED_THROUGH.iter().map(|(n, s)| (n.to_string(), s.to_string())));
    tables.sort();
    tables
}

#[tokio::test]
async fn a_guild_arrives_whole() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:a.example").await.unwrap();
    assert_eq!(new_guild, s.guild);

    let tables = everything_a_guild_is(&a.pool).await;
    assert!(tables.len() > 20, "the schema stopped answering: {tables:?}");
    for (table, scope) in tables {
        let here = rows(&a.pool, &table, &scope, &s.guild).await;
        assert!(!here.is_empty(), "nothing seeded into {table}, so nothing is proven about it");
        let there = rows(&b.pool, &table, &scope, &new_guild).await;
        assert_eq!(
            rehomed(here, "a.example", "b.example"),
            there,
            "{table} did not survive the move"
        );
    }
}

async fn stranded(pool: &SqlitePool, guild: &str) -> Vec<String> {
    let ulid = regex::Regex::new(r"[0-9A-Z]{26}").unwrap();

    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
    known.insert(guild.to_string());
    for (table, scope) in everything_a_guild_is(pool).await {
        let has_id: Option<String> = sqlx::query_scalar(
            "SELECT name FROM pragma_table_info(?) WHERE name = 'id'",
        )
        .bind(&table)
        .fetch_optional(pool)
        .await
        .unwrap();
        if has_id.is_none() {
            continue;
        }
        let sql = format!("SELECT \"{table}\".\"id\" FROM \"{table}\" {scope}");
        let ids: Vec<String> = sqlx::query_scalar(&sql).bind(guild).fetch_all(pool).await.unwrap();
        known.extend(ids);
    }

    let mut out = Vec::new();
    for (table, scope) in everything_a_guild_is(pool).await {
        for row in rows(pool, &table, &scope, guild).await {
            for m in ulid.find_iter(&row) {
                let id = m.as_str().to_string();
                if !known.contains(&id) {
                    out.push(id);
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[tokio::test]
async fn a_renumbered_guild_arrives_whole_too() {
    let a = home("a.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&a, &bundle, "@ana:a.example").await.unwrap();
    assert_ne!(new_guild, s.guild);

    for (table, scope) in everything_a_guild_is(&a.pool).await {
        let here = rows(&a.pool, &table, &scope, &s.guild).await;
        let there = rows(&a.pool, &table, &scope, &new_guild).await;
        assert_eq!(here.len(), there.len(), "{table} lost rows to the renumbering");
    }

    assert_eq!(dangling(&a.pool, &new_guild).await, vec![s.elsewhere.clone()]);

    assert_eq!(
        stranded(&a.pool, &new_guild).await,
        stranded(&a.pool, &s.guild).await,
        "the renumbering left an id pointing at the guild it came from"
    );
}
