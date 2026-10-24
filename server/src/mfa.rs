
use crate::config::Config;
use crate::rotations::{self, Actor, Detail};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use sqlx::SqlitePool;
use std::io;
use std::path::Path;

pub type Key = [u8; 32];

const SEALED_V1: &str = "tmfa1:";

fn decode_key(text: &str) -> anyhow::Result<Key> {
    let bytes = STANDARD
        .decode(text.trim())
        .map_err(|_| anyhow::anyhow!("the MFA key is not valid base64"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("the MFA key must decode to exactly 32 bytes"))
}

fn read_key_file(path: &Path) -> anyhow::Result<Option<Key>> {
    match std::fs::read_to_string(path) {
        Ok(text) => decode_key(&text)
            .map(Some)
            .map_err(|e| anyhow::anyhow!("{}: {e}", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::anyhow!("reading {}: {e}", path.display())),
    }
}

pub struct Keyring {
    pub current: Option<Key>,
    pub retired: Vec<Key>,
}

impl Keyring {
    pub fn all(&self) -> Vec<Key> {
        self.current
            .into_iter()
            .chain(self.retired.iter().copied())
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.current.is_none() && self.retired.is_empty()
    }

    pub fn empty() -> Keyring {
        Keyring {
            current: None,
            retired: Vec::new(),
        }
    }

    pub fn of(key: Key) -> Keyring {
        Keyring {
            current: Some(key),
            retired: Vec::new(),
        }
    }
}

pub fn load_keyring(cfg: &Config) -> anyhow::Result<Keyring> {
    let current = read_key_file(&cfg.mfa.key_file)?;
    let mut retired = Vec::new();
    for path in &cfg.mfa.previous_key_files {
        let key = read_key_file(path)?.ok_or_else(|| {
            anyhow::anyhow!(
                "mfa.previous_key_files names {} and it is not there. Accounts still sealed \
                 under that key cannot use their authenticator without it.",
                path.display()
            )
        })?;
        if Some(key) != current && !retired.contains(&key) {
            retired.push(key);
        }
    }
    Ok(Keyring { current, retired })
}

fn write_new_key(path: &Path) -> io::Result<Key> {
    let mut key = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut staging = path.as_os_str().to_owned();
    staging.push(format!(".{}.{nonce}.tmp", std::process::id()));
    let staging = std::path::PathBuf::from(staging);

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    {
        let mut file = opts.open(&staging)?;
        use std::io::Write as _;
        file.write_all(STANDARD.encode(key).as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    let linked = std::fs::hard_link(&staging, path);
    let _ = std::fs::remove_file(&staging);
    linked?;
    Ok(key)
}

pub fn keygen(path: &Path) -> anyhow::Result<Key> {
    write_new_key(path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            anyhow::anyhow!(
                "{} already exists; not overwriting the key that every enrolled account's \
                 second factor is sealed under",
                path.display()
            )
        } else {
            anyhow::anyhow!("creating {}: {e}", path.display())
        }
    })
}

fn load_or_create(path: &Path) -> anyhow::Result<(Key, bool)> {
    if let Some(key) = read_key_file(path)? {
        return Ok((key, false));
    }
    match write_new_key(path) {
        Ok(key) => Ok((key, true)),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => read_key_file(path)?
            .map(|key| (key, false))
            .ok_or_else(|| anyhow::anyhow!("{} appeared and then vanished", path.display())),
        Err(e) => Err(anyhow::anyhow!("creating {}: {e}", path.display())),
    }
}

pub fn seal(key: &Key, user_id: &str, secret: &str) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: secret.as_bytes(),
                aad: user_id.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("sealing the second factor failed"))?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{SEALED_V1}{}", STANDARD.encode(blob)))
}

pub fn open(ring: &Keyring, user_id: &str, sealed: &str) -> anyhow::Result<Option<String>> {
    let body = sealed.strip_prefix(SEALED_V1).ok_or_else(|| {
        anyhow::anyhow!("a stored second factor is not in a format this build knows")
    })?;
    let blob = STANDARD
        .decode(body)
        .map_err(|_| anyhow::anyhow!("a stored second factor is not valid base64"))?;
    if blob.len() < 13 {
        anyhow::bail!("a stored second factor is too short to be a sealed value");
    }
    let (nonce_bytes, ciphertext) = blob.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    for key in ring.all() {
        let cipher = Aes256Gcm::new((&key).into());
        if let Ok(plain) = cipher.decrypt(
            nonce,
            Payload {
                msg: ciphertext,
                aad: user_id.as_bytes(),
            },
        ) {
            return Ok(String::from_utf8(plain).ok());
        }
    }
    Ok(None)
}

pub fn from_row(
    ring: &Keyring,
    user_id: &str,
    cleartext: Option<&str>,
    sealed: Option<&str>,
) -> Option<String> {
    if let Some(sealed) = sealed {
        return match open(ring, user_id, sealed) {
            Ok(secret) => secret,
            Err(e) => {
                tracing::error!(
                    target: crate::logcat::AUTH,
                    error = %e,
                    "a stored second factor could not be read; that account's authenticator \
                     will not work until it re-enrols"
                );
                None
            }
        };
    }
    cleartext.map(str::to_string)
}

pub fn is_sealed(sealed: Option<&str>) -> bool {
    sealed.is_some_and(|s| s.starts_with(SEALED_V1))
}

pub async fn start(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<Keyring> {
    let ring = load_keyring(cfg)?;
    let ring = if ring.is_empty() {
        if sealed_count(pool).await? > 0 {
            Keyring::empty()
        } else {
            let (key, minted) = load_or_create(&cfg.mfa.key_file)?;
            let path = std::fs::canonicalize(&cfg.mfa.key_file)
                .unwrap_or_else(|_| cfg.mfa.key_file.clone());
            if minted {
                tracing::error!(
                    target: crate::logcat::STARTUP,
                    path = %path.display(),
                    "GENERATED A NEW MFA ENCRYPTION KEY. Every account's second factor will be \
                     sealed under it. Back it up somewhere that is NOT the database backup -- a \
                     copy of this key inside an archive that contains the database protects nobody."
                );
            }
            Keyring::of(key)
        }
    } else {
        ring
    };

    let sealed = seal_pending(pool, &ring).await?;
    if sealed > 0 {
        tracing::info!(
            target: crate::logcat::STARTUP,
            accounts = sealed,
            "encrypted second factors that were stored in cleartext"
        );
    }
    Ok(ring)
}

pub async fn sealed_count(pool: &SqlitePool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE mfa_sealed IS NOT NULL")
        .fetch_one(pool)
        .await
}

pub async fn refuse_if_locked_out(
    pool: &SqlitePool,
    cfg: &Config,
    ring: &Keyring,
) -> anyhow::Result<()> {
    if ring.current.is_some() {
        return Ok(());
    }
    let sealed = sealed_count(pool).await?;
    if sealed == 0 {
        return Ok(());
    }
    anyhow::bail!(
        "{sealed} account(s) have a second factor sealed under an MFA key, and there is no key \
         at mfa.key_file ({}). Starting would leave every one of those accounts unable to use \
         its authenticator, and they would each find that out separately, at the worst moment, \
         without being told why.\n\n\
         If the file has moved, point mfa.key_file at it -- that is what this almost always \
         is. If a rotation is half-done, the old key belongs in mfa.previous_key_files. If it \
         is genuinely gone: accounts holding an unused recovery code can still sign in, because \
         recovery codes are hashed separately and are not sealed under this key, and \
         `telium-server mfa reset-all` turns the second factor off for everybody, mails the \
         accounts that have a verified address, and lets the server start.",
        cfg.mfa.key_file.display()
    )
}

pub async fn seal_pending(pool: &SqlitePool, ring: &Keyring) -> anyhow::Result<u64> {
    let Some(key) = ring.current else {
        return Ok(0);
    };
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id, mfa_secret FROM accounts WHERE mfa_secret IS NOT NULL")
            .fetch_all(pool)
            .await?;
    let mut done = 0;
    for (user_id, secret) in rows {
        let sealed = seal(&key, &user_id, &secret)?;
        sqlx::query("UPDATE accounts SET mfa_sealed = ?, mfa_secret = NULL WHERE user_id = ?")
            .bind(&sealed)
            .bind(&user_id)
            .execute(pool)
            .await?;
        done += 1;
    }
    Ok(done)
}

pub async fn unopenable_count(pool: &SqlitePool, ring: &Keyring) -> anyhow::Result<i64> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id, mfa_sealed FROM accounts WHERE mfa_sealed IS NOT NULL")
            .fetch_all(pool)
            .await?;
    let mut stuck = 0;
    for (user_id, sealed) in rows {
        if open(ring, &user_id, &sealed).unwrap_or(None).is_none() {
            stuck += 1;
        }
    }
    Ok(stuck)
}

pub async fn unseal_all(pool: &SqlitePool, ring: &Keyring) -> anyhow::Result<(u64, u64)> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id, mfa_sealed FROM accounts WHERE mfa_sealed IS NOT NULL")
            .fetch_all(pool)
            .await?;
    let (mut done, mut stuck) = (0, 0);
    for (user_id, sealed) in rows {
        match open(ring, &user_id, &sealed)? {
            Some(secret) => {
                sqlx::query(
                    "UPDATE accounts SET mfa_secret = ?, mfa_sealed = NULL WHERE user_id = ?",
                )
                .bind(&secret)
                .bind(&user_id)
                .execute(pool)
                .await?;
                done += 1;
            }
            None => stuck += 1,
        }
    }
    Ok((done, stuck))
}

pub async fn rekey(pool: &SqlitePool, ring: &Keyring) -> anyhow::Result<(u64, u64)> {
    let Some(key) = ring.current else {
        anyhow::bail!("there is no current MFA key to re-seal under; check mfa.key_file")
    };
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT user_id, mfa_sealed FROM accounts WHERE mfa_sealed IS NOT NULL")
            .fetch_all(pool)
            .await?;
    let (mut done, mut stuck) = (0, 0);
    for (user_id, sealed) in rows {
        match open(ring, &user_id, &sealed)? {
            Some(secret) => {
                let resealed = seal(&key, &user_id, &secret)?;
                sqlx::query("UPDATE accounts SET mfa_sealed = ? WHERE user_id = ?")
                    .bind(&resealed)
                    .bind(&user_id)
                    .execute(pool)
                    .await?;
                done += 1;
            }
            None => stuck += 1,
        }
    }
    Ok((done, stuck))
}

pub struct Reset {
    pub accounts: Vec<String>,
    pub recovery_codes_destroyed: u64,
}

pub async fn reset_all(pool: &SqlitePool, reason: &str) -> anyhow::Result<Reset> {
    let accounts: Vec<(String,)> = sqlx::query_as(
        "SELECT user_id FROM accounts \
         WHERE mfa_enabled = 1 OR mfa_secret IS NOT NULL OR mfa_sealed IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let accounts: Vec<String> = accounts.into_iter().map(|(u,)| u).collect();
    if accounts.is_empty() {
        return Ok(Reset {
            accounts,
            recovery_codes_destroyed: 0,
        });
    }

    let mut tx = pool.begin().await?;
    let mut destroyed = 0;
    for user_id in &accounts {
        sqlx::query(
            "UPDATE accounts SET mfa_secret = NULL, mfa_sealed = NULL, mfa_enabled = 0, \
             mfa_reenrol_required = 1 WHERE user_id = ?",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        destroyed += sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    }
    tx.commit().await?;

    let _ = reason;
    Ok(Reset {
        accounts,
        recovery_codes_destroyed: destroyed,
    })
}

pub async fn record_reset(pool: &SqlitePool, actor: &Actor, affected: i64) -> anyhow::Result<()> {
    let entry = crate::secrets::by_heading("Per-user MFA secrets")
        .expect("per-user MFA secrets are in the inventory");
    rotations::record(
        pool,
        entry,
        actor,
        Detail {
            change: "invalidated",
            note: "telium-server mfa reset-all. Every enrolment on the server was invalidated \
                   and every recovery code destroyed; the affected accounts must enrol a \
                   second factor again. A TOTP secret cannot be changed server-side -- this \
                   is the server refusing to honour the old ones",
            affected: Some(affected),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "JBSWY3DPEHPK3PXP";

    fn key() -> Key {
        let mut k = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k);
        k
    }

    #[test]
    fn sealing_rules() {
        let (old, new) = (key(), key());
        let sealed = seal(&old, "@ada:test", S).unwrap();
        assert!(!sealed.contains(S) && sealed.starts_with(SEALED_V1));
        assert_eq!(open(&Keyring::of(old), "@ada:test", &sealed).unwrap().as_deref(), Some(S));
        assert_eq!(open(&Keyring::of(old), "@mallory:test", &sealed).unwrap(), None);
        let ring = Keyring { current: Some(new), retired: vec![old] };
        assert_eq!(open(&ring, "@ada:test", &sealed).unwrap().as_deref(), Some(S));
        assert_eq!(open(&Keyring::of(new), "@ada:test", &sealed).unwrap(), None);
    }

    #[test]
    fn a_row_that_is_not_sealed_is_read_as_it_stands() {
        let ring = Keyring::empty();
        assert_eq!(from_row(&ring, "@ada:test", Some(S), None).as_deref(), Some(S));
        assert_eq!(from_row(&ring, "@ada:test", None, None), None);
        assert!(!is_sealed(None) && !is_sealed(Some(S)) && is_sealed(Some("tmfa1:AAAA")));
    }

    #[test]
    fn concurrent_minting_of_one_key_file_agrees_on_one_key() {
        let dir = std::env::temp_dir().join(format!("telium-mfa-race-{}", crate::util::ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mfa.key");
        let keys: Vec<Key> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| load_or_create(&path).expect("minting raced").0))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(keys.windows(2).all(|w| w[0] == w[1]), "concurrent callers got different keys");
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(entries.len(), 1, "staging files survived");
    }
}
