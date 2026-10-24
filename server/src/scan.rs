
use crate::config::{HashListSource, Moderation};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use sha1::Digest;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Blake3,
    Sha256,
    Sha1,
}

impl Algorithm {
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "blake3" => Some(Self::Blake3),
            "sha256" => Some(Self::Sha256),
            "sha1" => Some(Self::Sha1),
            _ => None,
        }
    }

    fn digest(self, bytes: &[u8]) -> String {
        match self {
            Self::Blake3 => blake3::hash(bytes).to_hex().to_string(),
            Self::Sha256 => hex::encode(sha2::Sha256::digest(bytes)),
            Self::Sha1 => hex::encode(sha1::Sha1::digest(bytes)),
        }
    }
}

struct HashList {
    name: String,
    algorithm: Algorithm,
    digests: HashSet<String>,
}

pub struct HashLists {
    lists: Vec<HashList>,
}

impl HashLists {
    pub fn load(moderation: &Moderation) -> anyhow::Result<Self> {
        let mut lists = Vec::new();

        if !moderation.upload_hash_blocklist.is_empty() {
            lists.push(HashList {
                name: "config".into(),
                algorithm: Algorithm::Blake3,
                digests: moderation
                    .upload_hash_blocklist
                    .iter()
                    .map(|h| h.trim().to_ascii_lowercase())
                    .filter(|h| !h.is_empty())
                    .collect(),
            });
        }

        for source in &moderation.upload_hash_lists {
            lists.push(load_file(source)?);
        }

        for list in &lists {
            tracing::info!(
                target: crate::logcat::SCAN,
                list = %list.name,
                algorithm = ?list.algorithm,
                entries = list.digests.len(),
                "upload hash list loaded"
            );
        }
        Ok(Self { lists })
    }

    pub fn matches(&self, bytes: &[u8]) -> Option<&str> {
        for algorithm in [Algorithm::Blake3, Algorithm::Sha256, Algorithm::Sha1] {
            let mut of_this_algorithm =
                self.lists.iter().filter(|l| l.algorithm == algorithm).peekable();
            if of_this_algorithm.peek().is_none() {
                continue;
            }
            let digest = algorithm.digest(bytes);
            if let Some(hit) = of_this_algorithm.find(|l| l.digests.contains(&digest)) {
                return Some(&hit.name);
            }
        }
        None
    }

    pub fn entries(&self) -> usize {
        self.lists.iter().map(|l| l.digests.len()).sum()
    }
}

fn load_file(source: &HashListSource) -> anyhow::Result<HashList> {
    let algorithm = Algorithm::parse(&source.algorithm).ok_or_else(|| {
        anyhow::anyhow!(
            "hash list {}: unknown algorithm {:?} (blake3, sha256 or sha1)",
            source.name,
            source.algorithm
        )
    })?;
    let text = std::fs::read_to_string(&source.path).map_err(|e| {
        anyhow::anyhow!("hash list {}: reading {}: {e}", source.name, source.path.display())
    })?;
    let digests = text
        .lines()
        .map(|line| line.split('#').next().unwrap_or_default().trim())
        .filter_map(|line| line.split_whitespace().next())
        .map(|d| d.to_ascii_lowercase())
        .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_hexdigit()))
        .collect();
    Ok(HashList { name: source.name.clone(), algorithm, digests })
}

pub async fn screen_upload(
    state: &AppState,
    uploader: &str,
    hash: &str,
    bytes: &[u8],
) -> ApiResult<()> {
    crate::metrics::Metrics::bump(&state.metrics.media_scans, 1);
    let Some(list) = state.hash_lists.matches(bytes) else {
        return Ok(());
    };
    crate::metrics::Metrics::bump(&state.metrics.media_scan_matches, 1);

    tracing::warn!(
        target: crate::logcat::SCAN,
        list = %list,
        uploader = %uploader,
        hash = %hash,
        size = bytes.len(),
        "upload refused: content matches a hash list"
    );
    if let Err(err) = crate::federation::routes::record_scan_hit(state, uploader, hash, list).await
    {
        crate::metrics::Metrics::bump(&state.metrics.media_scan_failures, 1);
        tracing::error!(
            target: crate::logcat::SCAN,
            list = %list,
            hash = %hash,
            error = %err,
            "upload was refused but the hash-list finding could not be filed; it will not \
             appear in the takedown queue"
        );
    }

    // Uploader must not be able to probe list contents via rejections.
    Err(ApiError::Forbidden(
        "this file matches a hash list this origin screens uploads against, so it was not \
         stored. If you believe that is wrong, contact this server's operator."
            .into(),
    ))
}
