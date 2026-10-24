// What build is this, exactly?
//
// The crate version has been "0.1.0" since the repository was created and will
// probably still be "0.1.0" when this stops being true, because nothing in this
// project releases on a semver cadence. What a release actually *is* here is a
// commit on `main` that CI turned into an image, so the honest identifier for a
// running server is the commit it was built from and the moment that commit was
// made. That is what this file compiles in.
//
// Two sources, in order:
//
//   1. The environment. A container build has no `.git` -- `.dockerignore`
//      excludes it, and it should, since half a gigabyte of history has no
//      business in a build context -- so CI passes the facts in as build args.
//      This is the path every shipped image takes.
//   2. `git`, for a developer building in a checkout. Best-effort: a tarball
//      export, a vendored build, or a machine without git all land on the
//      fallback rather than failing the build.
//
// The fallback is the empty string, and it is deliberately not a lie like
// "dev" or "0.0.0-unknown". `updates.rs` treats an unidentifiable build as
// unknown rather than as current, which is the only safe direction: a server
// that cannot say what it is must not be told it is up to date.

use std::process::Command;

fn main() {
    // Only these three inputs can change the output, so only these three
    // should force a rerun. Without them Cargo reruns build.rs on every
    // source change, which is harmless but wasteful, and -- worse -- *stops*
    // rerunning it when only `.git/HEAD` moves, which is exactly when the
    // answer changes.
    println!("cargo:rerun-if-env-changed=TELIUM_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=TELIUM_BUILD_COMMIT_TIME");
    println!("cargo:rerun-if-env-changed=TELIUM_BUILD_TIME");
    for path in ["../.git/HEAD", "../.git/refs/heads/main"] {
        if std::path::Path::new(path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }

    let commit = from_env("TELIUM_BUILD_COMMIT")
        .or_else(|| git(&["rev-parse", "HEAD"]))
        .unwrap_or_default();
    // Normalised to lowercase hex here rather than at every comparison site.
    // A manifest written by CI and a `git rev-parse` on a developer's machine
    // agree on the bytes but not always on the case.
    let commit = commit.trim().to_ascii_lowercase();
    let commit = if commit.chars().all(|c| c.is_ascii_hexdigit()) && commit.len() == 40 {
        commit
    } else {
        String::new()
    };

    // Seconds since the epoch, both of them, because that is what `git` hands
    // out and what a JSON manifest can carry without a date parser.
    let commit_time = from_env("TELIUM_BUILD_COMMIT_TIME")
        .or_else(|| git(&["log", "-1", "--format=%ct"]))
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);
    let build_time = from_env("TELIUM_BUILD_TIME")
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0)
        });

    println!("cargo:rustc-env=TELIUM_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=TELIUM_BUILD_COMMIT_TIME={commit_time}");
    println!("cargo:rustc-env=TELIUM_BUILD_TIME={build_time}");
}

/// An environment variable that is set but empty is the same as unset here: CI
/// passing `--build-arg TELIUM_BUILD_COMMIT=` should fall through to git rather
/// than compile in a blank that git could have filled.
fn from_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}
