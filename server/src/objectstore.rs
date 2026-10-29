
use crate::backup::S3Client;
use crate::config::{Remote, StoreBackend};
use crate::error::{ApiError, ApiResult};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Clone)]
pub enum ObjectStore {
    Local,
    S3(Box<S3Client>),
}

impl ObjectStore {
    pub async fn new(backend: &StoreBackend, s3: &Remote) -> ApiResult<Self> {
        match backend {
            StoreBackend::Local => Ok(ObjectStore::Local),
            StoreBackend::S3 => {
                let client = S3Client::from_config(s3).map_err(|e| ApiError::Internal(e.into()))?;
                client.ensure_bucket().await.map_err(|e| ApiError::Internal(e.into()))?;
                Ok(ObjectStore::S3(Box::new(client)))
            }
        }
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>) -> ApiResult<()> {
        match self {
            ObjectStore::Local => {
                let path = Path::new(key).to_path_buf();
                let parent = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                tokio::fs::create_dir_all(&parent)
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?;
                tokio::task::spawn_blocking(move || write_durably(&parent, &path, &bytes))
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?
                    .map_err(|e| ApiError::Internal(e.into()))
            }            ObjectStore::S3(s3) => s3.put_bytes(key, bytes).await.map_err(|e| ApiError::Internal(e.into())),
        }
    }

    /// Persists bytes that are already on local disk at `from` without holding
    /// them in memory where avoidable: the local backend renames, the S3
    /// backend reads the file and uploads it. The source file is left in place;
    /// the caller owns its cleanup.
    pub async fn put_from_file(&self, key: &str, from: &Path) -> ApiResult<()> {
        match self {
            ObjectStore::Local => {
                let path = Path::new(key).to_path_buf();
                let parent = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                tokio::fs::create_dir_all(&parent)
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?;
                // Same volume is the normal case: a rename, atomic and free.
                if tokio::fs::rename(from, &path).await.is_ok() {
                    if let Ok(dir) = std::fs::File::open(&parent) {
                        if let Err(err) = dir.sync_all() {
                            tracing::debug!(target: crate::logcat::MEDIA, %err, dir = %parent.display(), "could not fsync object store directory");
                        }
                    }
                    return Ok(());
                }
                // Cross-device staging: read it back and write durably.
                let bytes = tokio::fs::read(from).await.map_err(|e| ApiError::Internal(e.into()))?;
                tokio::task::spawn_blocking(move || write_durably(&parent, &path, &bytes))
                    .await
                    .map_err(|e| ApiError::Internal(e.into()))?
                    .map_err(|e| ApiError::Internal(e.into()))
            }
            ObjectStore::S3(s3) => {
                let bytes = tokio::fs::read(from).await.map_err(|e| ApiError::Internal(e.into()))?;
                s3.put_bytes(key, bytes).await.map_err(|e| ApiError::Internal(e.into()))
            }
        }
    }

    pub async fn get(&self, key: &str) -> ApiResult<Vec<u8>> {
        match self {
            ObjectStore::Local => tokio::fs::read(key).await.map_err(|e| ApiError::Internal(e.into())),
            ObjectStore::S3(s3) => s3.get_bytes(key).await.map_err(|e| ApiError::Internal(e.into())),
        }
    }

    pub async fn delete(&self, key: &str) -> ApiResult<()> {
        match self {
            ObjectStore::Local => match tokio::fs::remove_file(key).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(ApiError::Internal(e.into())),
            },
            ObjectStore::S3(s3) => s3.delete(key).await.map_err(|e| ApiError::Internal(e.into())),
        }
    }

    pub async fn get_range(&self, key: &str, start: u64, end: u64) -> ApiResult<Vec<u8>> {
        match self {
            ObjectStore::Local => {
                let mut file = tokio::fs::File::open(key).await.map_err(|e| ApiError::Internal(e.into()))?;
                file.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| ApiError::Internal(e.into()))?;
                let len = usize::try_from(end - start + 1).map_err(|e| ApiError::Internal(e.into()))?;
                let mut bytes = vec![0; len];
                file.read_exact(&mut bytes).await.map_err(|e| ApiError::Internal(e.into()))?;
                Ok(bytes)
            }
            ObjectStore::S3(s3) => {
                s3.get_bytes_range(key, start, end).await.map_err(|e| ApiError::Internal(e.into()))
            }
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, ObjectStore::Local)
    }
}

pub async fn write_atomically(path: &Path, bytes: &[u8]) -> ApiResult<()> {
    ObjectStore::Local.put(&path.to_string_lossy(), bytes.to_vec()).await
}

fn write_durably(parent: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let stem = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = parent.join(format!(
        ".tmp-{}-{}-{stem}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let staged = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        // Contents before name; reversing loses data on crash.
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if staged.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return staged;
    }

    if let Ok(dir) = std::fs::File::open(parent) {
        if let Err(err) = dir.sync_all() {
            tracing::debug!(target: crate::logcat::MEDIA, %err, dir = %parent.display(), "could not fsync object store directory");
        }    }
    Ok(())
}
