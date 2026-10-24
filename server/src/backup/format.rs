//! ```text
//! header (plaintext, 21 bytes, used as the AAD of every chunk)
//!   magic        "TELIUMBK"   8 bytes
//!   version      u16 BE       1
//!   nonce prefix 7 random bytes
//!   chunk size   u32 BE       plaintext bytes per body chunk
//! chunk 0        the manifest, JSON
//! chunk 1..n     the gzip'd tar, `chunk size` bytes at a time; n carries the
//!                last-chunk flag and may be shorter, or empty
//! ```

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 8] = b"TELIUMBK";
pub const VERSION: u16 = 1;
pub const DEFAULT_CHUNK_SIZE: u32 = 1024 * 1024;
const MAX_CHUNK_SIZE: u32 = 64 * 1024 * 1024;
const HEADER_LEN: usize = 8 + 2 + 7 + 4;
const TAG_LEN: usize = 16;
const FLAG_MORE: u8 = 0;
const FLAG_LAST: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub format: u16,
    pub server_name: String,
    pub created_at: i64,
    pub schema_version: i64,
    pub telium_version: String,
    pub parts: Vec<Part>,
    #[serde(default)]
    pub excluded: Vec<Excluded>,
    pub payload_bytes: u64,
    pub payload_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Excluded {
    pub kind: String,
    pub reason: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Part {
    pub kind: String,
    pub name: String,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("not a Telium backup archive (bad magic)")]
    BadMagic,
    #[error("unsupported backup archive version {0}")]
    UnsupportedVersion(u16),
    #[error("backup archive header is invalid: {0}")]
    BadHeader(&'static str),
    #[error("backup archive is truncated: it ends before its final chunk")]
    Truncated,
    #[error("backup archive has data after its final chunk")]
    TrailingData,
    #[error("chunk {0} failed authentication: wrong key, or the archive was modified, reordered or corrupted")]
    Auth(u32),
    #[error("backup archive has a chunk larger than its declared chunk size")]
    Oversize,
    #[error("backup manifest is not valid: {0}")]
    Manifest(String),
    #[error(transparent)]
    Io(io::Error),
}

impl From<FormatError> for io::Error {
    fn from(e: FormatError) -> Self {
        match e {
            FormatError::Io(e) => e,
            other => io::Error::new(io::ErrorKind::InvalidData, other),
        }
    }
}

impl From<io::Error> for FormatError {
    fn from(e: io::Error) -> Self {
        match e.downcast::<FormatError>() {
            Ok(inner) => inner,
            Err(e) => FormatError::Io(e),
        }
    }
}

fn nonce(prefix: &[u8; 7], counter: u32, flag: u8) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[..7].copy_from_slice(prefix);
    n[7..11].copy_from_slice(&counter.to_be_bytes());
    n[11] = flag;
    n
}

fn encode_header(prefix: &[u8; 7], chunk_size: u32) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[..8].copy_from_slice(MAGIC);
    h[8..10].copy_from_slice(&VERSION.to_be_bytes());
    h[10..17].copy_from_slice(prefix);
    h[17..21].copy_from_slice(&chunk_size.to_be_bytes());
    h
}

pub struct Writer<W: Write> {
    out: W,
    cipher: Aes256Gcm,
    header: [u8; HEADER_LEN],
    prefix: [u8; 7],
    chunk_size: usize,
    buf: Vec<u8>,
    counter: u32,
    finished: bool,
}

impl<W: Write> Writer<W> {
    pub fn new(out: W, key: &[u8; 32], manifest: &Manifest) -> Result<Self, FormatError> {
        Self::with_chunk_size(out, key, manifest, DEFAULT_CHUNK_SIZE)
    }

    pub fn with_chunk_size(
        mut out: W,
        key: &[u8; 32],
        manifest: &Manifest,
        chunk_size: u32,
    ) -> Result<Self, FormatError> {
        if chunk_size == 0 || chunk_size > MAX_CHUNK_SIZE {
            return Err(FormatError::BadHeader("chunk size out of range"));
        }
        let mut prefix = [0u8; 7];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut prefix);
        let header = encode_header(&prefix, chunk_size);
        out.write_all(&header)?;
        let mut w = Self {
            out,
            cipher: Aes256Gcm::new(key.into()),
            header,
            prefix,
            chunk_size: chunk_size as usize,
            buf: Vec::with_capacity(chunk_size as usize),
            counter: 0,
            finished: false,
        };
        let manifest = serde_json::to_vec(manifest)
            .map_err(|e| FormatError::Manifest(e.to_string()))?;
        w.seal(&manifest, FLAG_MORE)?;
        Ok(w)
    }

    fn seal(&mut self, plaintext: &[u8], flag: u8) -> Result<(), FormatError> {
        let n = nonce(&self.prefix, self.counter, flag);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&n), Payload { msg: plaintext, aad: &self.header })
            .map_err(|_| FormatError::Auth(self.counter))?;
        self.out.write_all(&[flag])?;
        self.out.write_all(&(ct.len() as u32).to_be_bytes())?;
        self.out.write_all(&ct)?;
        self.counter = self
            .counter
            .checked_add(1)
            .ok_or(FormatError::BadHeader("too many chunks"))?;
        Ok(())
    }

    pub fn finish(mut self) -> Result<W, FormatError> {
        let last = std::mem::take(&mut self.buf);
        self.seal(&last, FLAG_LAST)?;
        self.finished = true;
        self.out.flush()?;
        Ok(self.out)
    }
}

impl<W: Write> Write for Writer<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let room = self.chunk_size - self.buf.len();
        let take = room.min(data.len());
        self.buf.extend_from_slice(&data[..take]);
        if self.buf.len() == self.chunk_size {
            let full = std::mem::replace(&mut self.buf, Vec::with_capacity(self.chunk_size));
            self.seal(&full, FLAG_MORE)?;
        }
        Ok(take)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

pub struct Reader<R: Read> {
    inp: R,
    cipher: Aes256Gcm,
    header: [u8; HEADER_LEN],
    prefix: [u8; 7],
    chunk_size: usize,
    manifest: Manifest,
    buf: Vec<u8>,
    pos: usize,
    counter: u32,
    finished: bool,
}

impl<R: Read> Reader<R> {
    pub fn open(mut inp: R, key: &[u8; 32]) -> Result<Self, FormatError> {
        let mut header = [0u8; HEADER_LEN];
        inp.read_exact(&mut header).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof { FormatError::BadMagic } else { e.into() }
        })?;
        if &header[..8] != MAGIC {
            return Err(FormatError::BadMagic);
        }
        let version = u16::from_be_bytes([header[8], header[9]]);
        if version != VERSION {
            return Err(FormatError::UnsupportedVersion(version));
        }
        let mut prefix = [0u8; 7];
        prefix.copy_from_slice(&header[10..17]);
        let chunk_size = u32::from_be_bytes([header[17], header[18], header[19], header[20]]);
        if chunk_size == 0 || chunk_size > MAX_CHUNK_SIZE {
            return Err(FormatError::BadHeader("chunk size out of range"));
        }
        let mut r = Self {
            inp,
            cipher: Aes256Gcm::new(key.into()),
            header,
            prefix,
            chunk_size: chunk_size as usize,
            manifest: Manifest {
                format: VERSION,
                server_name: String::new(),
                created_at: 0,
                schema_version: 0,
                telium_version: String::new(),
                parts: Vec::new(),
                excluded: Vec::new(),
                payload_bytes: 0,
                payload_sha256: String::new(),
            },
            buf: Vec::new(),
            pos: 0,
            counter: 0,
            finished: false,
        };
        let (flag, manifest) = r.next_chunk()?.ok_or(FormatError::Truncated)?;
        if flag != FLAG_MORE {
            // A manifest-only archive was never finished.
            return Err(FormatError::Truncated);
        }
        r.manifest = serde_json::from_slice(&manifest)
            .map_err(|e| FormatError::Manifest(e.to_string()))?;
        Ok(r)
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn finished(&self) -> bool {
        self.finished
    }

    fn next_chunk(&mut self) -> Result<Option<(u8, Vec<u8>)>, FormatError> {
        if self.finished {
            // Anything after the final chunk means we did not write this archive.
            let mut probe = [0u8; 1];
            return match self.inp.read(&mut probe)? {
                0 => Ok(None),
                _ => Err(FormatError::TrailingData),
            };
        }
        let mut head = [0u8; 5];
        let mut got = 0;
        while got < head.len() {
            match self.inp.read(&mut head[got..])? {
                0 => return Err(FormatError::Truncated),
                n => got += n,
            }
        }
        let flag = head[0];
        let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
        if flag != FLAG_MORE && flag != FLAG_LAST {
            return Err(FormatError::Auth(self.counter));
        }
        if len < TAG_LEN || len > self.chunk_size + TAG_LEN {
            return Err(FormatError::Oversize);
        }
        let mut ct = vec![0u8; len];
        self.inp.read_exact(&mut ct).map_err(|e| {
            if e.kind() == io::ErrorKind::UnexpectedEof { FormatError::Truncated } else { e.into() }
        })?;
        let n = nonce(&self.prefix, self.counter, flag);
        let pt = self
            .cipher
            .decrypt(Nonce::from_slice(&n), Payload { msg: &ct, aad: &self.header })
            .map_err(|_| FormatError::Auth(self.counter))?;
        self.counter = self.counter.wrapping_add(1);
        if flag == FLAG_LAST {
            self.finished = true;
        }
        Ok(Some((flag, pt)))
    }

    pub fn into_inner(self) -> R {
        self.inp
    }
}

impl<R: Read> Read for Reader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        while self.pos >= self.buf.len() {
            match self.next_chunk()? {
                None => return Ok(0),
                Some((_, pt)) => {
                    self.buf = pt;
                    self.pos = 0;
                }
            }
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(b: u8) -> [u8; 32] {
        [b; 32]
    }

    fn manifest() -> Manifest {
        Manifest {
            format: VERSION,
            server_name: "a.test".into(),
            created_at: 1_700_000_000_000,
            schema_version: 31,
            telium_version: "0.1.0".into(),
            parts: vec![Part { kind: "database".into(), name: "db/telium.db".into(), files: 1, bytes: 4096 }],
            excluded: Vec::new(),
            payload_bytes: 0,
            payload_sha256: String::new(),
        }
    }

    fn seal(payload: &[u8], chunk: u32, k: &[u8; 32]) -> Vec<u8> {
        let mut w = Writer::with_chunk_size(Vec::new(), k, &manifest(), chunk).unwrap();
        w.write_all(payload).unwrap();
        w.finish().unwrap()
    }

    fn open_all(bytes: &[u8], k: &[u8; 32]) -> Result<(Manifest, Vec<u8>), FormatError> {
        let mut r = Reader::open(bytes, k)?;
        let mut out = Vec::new();
        r.read_to_end(&mut out)?;
        assert!(r.finished(), "read to end without seeing the final chunk");
        Ok((r.manifest().clone(), out))
    }

    fn frames(bytes: &[u8]) -> Vec<std::ops::Range<usize>> {
        let mut at = HEADER_LEN;
        let mut out = Vec::new();
        while at < bytes.len() {
            let len = u32::from_be_bytes([bytes[at + 1], bytes[at + 2], bytes[at + 3], bytes[at + 4]]) as usize;
            out.push(at..at + 5 + len);
            at += 5 + len;
        }
        out
    }

    #[test]
    fn round_trips_across_chunk_boundaries() {
        let payload: Vec<u8> = (0..100_003u32).map(|i| (i % 251) as u8).collect();
        let sealed = seal(&payload, 4096, &key(1));
        let (m, got) = open_all(&sealed, &key(1)).unwrap();
        assert_eq!(m, manifest());
        assert_eq!(got, payload);
        assert_eq!(frames(&sealed).len(), 1 + 24 + 1);
    }

    #[test]
    fn an_empty_payload_is_a_valid_archive() {
        let sealed = seal(&[], 4096, &key(1));
        let (m, got) = open_all(&sealed, &key(1)).unwrap();
        assert_eq!(m.server_name, "a.test");
        assert!(got.is_empty());
        assert_eq!(frames(&sealed).len(), 2);
    }

    #[test]
    fn an_exact_multiple_of_the_chunk_size_still_ends_with_a_flagged_chunk() {
        let payload = vec![7u8; 8192];
        let sealed = seal(&payload, 4096, &key(1));
        assert_eq!(frames(&sealed).len(), 1 + 2 + 1, "an empty flagged chunk closes it");
        let (_, got) = open_all(&sealed, &key(1)).unwrap();
        assert_eq!(got, payload);
    }

    #[test]
    fn the_wrong_key_is_refused_at_the_manifest() {
        let sealed = seal(b"hello", 4096, &key(1));
        match Reader::open(&sealed[..], &key(2)) {
            Err(FormatError::Auth(0)) => {}
            Err(other) => panic!("expected an authentication failure on chunk 0, got {other:?}"),
            Ok(_) => panic!("the wrong key opened the archive"),
        }
    }

    #[test]
    fn truncation_is_detected_wherever_it_happens() {
        let payload = vec![3u8; 10_000];
        let sealed = seal(&payload, 1024, &key(1));
        let fr = frames(&sealed);
        let cut = &sealed[..fr[fr.len() - 1].start];
        match open_all(cut, &key(1)) {
            Err(FormatError::Truncated) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
        let cut = &sealed[..sealed.len() - 7];
        match open_all(cut, &key(1)) {
            Err(FormatError::Truncated) => {}
            other => panic!("expected Truncated, got {other:?}"),
        }
        match Reader::open(&sealed[..HEADER_LEN + 9], &key(1)) {
            Err(FormatError::Truncated) => {}
            other => panic!("expected Truncated, got {:?}", other.err()),
        }
    }

    #[test]
    fn reordered_chunks_are_detected() {
        let payload: Vec<u8> = (0..5000u32).map(|i| (i % 7) as u8).collect();
        let sealed = seal(&payload, 1024, &key(1));
        let fr = frames(&sealed);
        assert!(fr.len() >= 4);
        let mut swapped = sealed[..fr[1].start].to_vec();
        swapped.extend_from_slice(&sealed[fr[2].clone()]);
        swapped.extend_from_slice(&sealed[fr[1].clone()]);
        swapped.extend_from_slice(&sealed[fr[3].start..]);
        match open_all(&swapped, &key(1)) {
            Err(FormatError::Auth(1)) => {}
            other => panic!("expected chunk 1 to fail authentication, got {other:?}"),
        }
    }

    #[test]
    fn a_dropped_chunk_and_a_forged_last_flag_are_both_detected() {
        let payload = vec![9u8; 4096];
        let sealed = seal(&payload, 1024, &key(1));
        let fr = frames(&sealed);
        let mut dropped = sealed[..fr[2].start].to_vec();
        dropped.extend_from_slice(&sealed[fr[3].start..]);
        assert!(matches!(open_all(&dropped, &key(1)), Err(FormatError::Auth(2))));
        let mut forged = sealed[..fr[2].end].to_vec();
        forged[fr[2].start] = FLAG_LAST;
        assert!(matches!(open_all(&forged, &key(1)), Err(FormatError::Auth(2))));
    }

    #[test]
    fn trailing_bytes_after_the_final_chunk_are_refused() {
        let mut sealed = seal(b"payload", 4096, &key(1));
        sealed.extend_from_slice(b"junk");
        assert!(matches!(open_all(&sealed, &key(1)), Err(FormatError::TrailingData)));
    }

    #[test]
    fn a_chunk_moved_between_archives_is_detected() {
        let a = seal(&vec![1u8; 3000], 1024, &key(1));
        let b = seal(&vec![2u8; 3000], 1024, &key(1));
        let fa = frames(&a);
        let fb = frames(&b);
        let mut mixed = a[..fa[2].start].to_vec();
        mixed.extend_from_slice(&b[fb[2].clone()]);
        mixed.extend_from_slice(&a[fa[3].start..]);
        assert!(matches!(open_all(&mixed, &key(1)), Err(FormatError::Auth(2))));
    }

    #[test]
    fn garbage_is_not_an_archive() {
        assert!(matches!(Reader::open(&b"not a backup"[..], &key(1)), Err(FormatError::BadMagic)));
        let mut wrong_version = seal(b"x", 4096, &key(1));
        wrong_version[9] = 9;
        assert!(matches!(Reader::open(&wrong_version[..], &key(1)), Err(FormatError::UnsupportedVersion(9))));
    }
}
