
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_millis() as i64
}

pub fn ulid() -> String {
    ulid::Ulid::new().to_string()
}

pub fn random_token(n: usize) -> String {
    let mut buf = vec![0u8; n];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    b64(&buf)
}

pub fn invite_code() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut buf = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    let random: String = buf
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect();
    format!("~{random}")
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

pub fn hash_token(token: &str) -> String {
    blake3::hash(token.as_bytes()).to_hex().to_string()
}

pub fn split_user_id(user_id: &str) -> Option<(&str, &str)> {
    let rest = user_id.strip_prefix('@')?;
    let (localpart, domain) = rest.split_once(':')?;
    if localpart.is_empty() || domain.is_empty() {
        return None;
    }
    Some((localpart, domain))
}

pub fn localpart_fault(s: &str) -> &'static str {
    if s.is_empty() {
        "too_short"
    } else if s.len() > 32 {
        "too_long"
    } else if !valid_localpart(s) {
        "charset"
    } else {
        ""
    }
}

pub fn valid_localpart(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' || c == '.')
}
