
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn mask(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            let mut depth = 0usize;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                    continue;
                }
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                out.push(if chars[i] == '\n' { '\n' } else { ' ' });
                i += 1;
            }
            continue;
        }
        if (c == 'r' || c == 'b') && !prev_is_ident(&chars, i) {
            let mut j = i;
            if chars[j] == 'b' && chars.get(j + 1) == Some(&'r') {
                j += 1;
            }
            if chars[j] == 'r' {
                let mut hashes = 0usize;
                let mut k = j + 1;
                while chars.get(k) == Some(&'#') {
                    hashes += 1;
                    k += 1;
                }
                if chars.get(k) == Some(&'"') {
                    for _ in i..=k {
                        out.push(' ');
                    }
                    i = mask_string_body(&chars, k + 1, &mut out, Some(hashes));
                    continue;
                }
            }
        }
        if c == '"' || (c == 'b' && next == Some('"') && !prev_is_ident(&chars, i)) {
            if c == 'b' {
                out.push(' ');
                i += 1;
            }
            out.push(' ');
            i = mask_string_body(&chars, i + 1, &mut out, None);
            continue;
        }
        if c == '\'' && !prev_is_ident(&chars, i) {
            let is_char = match next {
                Some('\\') => true,
                Some(_) => chars.get(i + 2) == Some(&'\''),
                None => false,
            };
            if is_char {
                out.push(' ');
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        out.push_str("  ");
                        i += 2;
                        continue;
                    }
                    out.push(' ');
                    let done = chars[i] == '\'';
                    i += 1;
                    if done {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn prev_is_ident(chars: &[char], i: usize) -> bool {
    i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')
}

fn mask_string_body(chars: &[char], mut i: usize, out: &mut String, raw_hashes: Option<usize>) -> usize {
    while i < chars.len() {
        let c = chars[i];
        if raw_hashes.is_none() && c == '\\' {
            out.push_str("  ");
            i += 2;
            continue;
        }
        if c == '"' {
            match raw_hashes {
                None => {
                    out.push(' ');
                    return i + 1;
                }
                Some(h) => {
                    if (1..=h).all(|n| chars.get(i + n) == Some(&'#')) {
                        for _ in 0..=h {
                            out.push(' ');
                        }
                        return i + h + 1;
                    }
                }
            }
        }
        out.push(if c == '\n' { '\n' } else { ' ' });
        i += 1;
    }
    i
}

const LOGGING: [&str; 5] = [
    "tracing::trace!",
    "tracing::debug!",
    "tracing::info!",
    "tracing::warn!",
    "tracing::error!",
];

fn invocations(masked: &str) -> Vec<(usize, String)> {
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < masked.len() {
        let Some((start, head)) = LOGGING
            .iter()
            .filter_map(|h| masked[at..].find(h).map(|o| (at + o, *h)))
            .min_by_key(|(o, _)| *o)
        else {
            break;
        };
        let mut k = start + head.len();
        while bytes.get(k).is_some_and(|b| b.is_ascii_whitespace()) {
            k += 1;
        }
        if bytes.get(k) != Some(&b'(') {
            at = start + head.len();
            continue;
        }
        let mut depth = 0usize;
        let mut end = k;
        while end < bytes.len() {
            match bytes[end] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            end += 1;
        }
        let line = masked[..start].matches('\n').count() + 1;
        out.push((line, masked[k + 1..end.min(masked.len())].to_string()));
        at = end + 1;
    }
    out
}

fn source_files() -> Vec<PathBuf> {
    let root = src_root();
    let mut files = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src is readable") {
            let path = entry.expect("a readable entry").path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn rel(path: &Path) -> String {
    path.strip_prefix(src_root())
        .expect("under src")
        .to_string_lossy()
        .replace('\\', "/")
}

fn target_constant(args: &str) -> Option<String> {
    let args = args.trim_start();
    let rest = args.strip_prefix("target:")?.trim_start();
    let rest = rest
        .strip_prefix("crate::logcat::")
        .or_else(|| rest.strip_prefix("telium_server::logcat::"))?;
    let name: String = rest.chars().take_while(|c| c.is_ascii_uppercase() || *c == '_').collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn declared_constants() -> BTreeMap<String, String> {
    let src = std::fs::read_to_string(src_root().join("logcat.rs")).expect("logcat.rs is readable");
    let mut out = BTreeMap::new();
    for line in src.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("pub const ") else { continue };
        let Some((name, rest)) = rest.split_once(": &str = ") else { continue };
        let Some(value) = rest.trim().strip_prefix('"').and_then(|v| v.split('"').next()) else {
            continue;
        };
        out.insert(name.to_string(), value.to_string());
    }
    out
}

#[test]
fn every_log_line_in_the_tree_names_a_category() {
    let vocabulary: BTreeSet<&str> = telium_server::logcat::ALL.into_iter().collect();
    let constants = declared_constants();

    let files = source_files();
    assert!(files.len() > 20, "the walk found {} files; it is not walking the tree", files.len());

    let mut sites = 0usize;
    let mut wrong: Vec<String> = Vec::new();
    for path in &files {
        let src = std::fs::read_to_string(path).expect("a readable file");
        let masked = mask(&src);
        for (line, args) in invocations(&masked) {
            sites += 1;
            let where_ = format!("{}:{}", rel(path), line);
            let Some(name) = target_constant(&args) else {
                wrong.push(format!(
                    "{where_}: no `target: crate::logcat::<CATEGORY>` as the first argument"
                ));
                continue;
            };
            let Some(value) = constants.get(&name) else {
                wrong.push(format!("{where_}: logcat::{name} is not declared in src/logcat.rs"));
                continue;
            };
            if !vocabulary.contains(value.as_str()) {
                wrong.push(format!(
                    "{where_}: logcat::{name} is {value:?}, which is not in logcat::ALL"
                ));
            }
        }
    }

    assert!(sites > 250, "the walk found only {sites} logging call sites; it has stopped seeing them");

    assert!(
        wrong.is_empty(),
        "{} logging call site(s) are not filed under a documented category.\n\
         Add `target: crate::logcat::<CATEGORY>` as the first argument, choosing the category from \
         src/logcat.rs. If none of them fits, the module's own documentation lists the four steps \
         for adding one.\n\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

#[test]
fn every_declared_category_is_listed_in_all() {
    let vocabulary: BTreeSet<&str> = telium_server::logcat::ALL.into_iter().collect();
    let constants = declared_constants();

    for (name, value) in &constants {
        if name == "ALL" {
            continue;
        }
        assert!(
            vocabulary.contains(value.as_str()),
            "src/logcat.rs declares {name} = {value:?} but does not list it in ALL, so nothing \
             that enumerates the vocabulary can see it"
        );
    }
}

#[test]
fn every_category_is_actually_used() {
    let constants = declared_constants();
    let mut used: BTreeSet<String> = BTreeSet::new();
    for path in source_files() {
        if rel(&path) == "logcat.rs" {
            continue;
        }
        let src = std::fs::read_to_string(&path).expect("a readable file");
        let masked = mask(&src);
        for (_, args) in invocations(&masked) {
            if let Some(name) = target_constant(&args) {
                used.insert(name);
            }
        }
    }
    let unused: Vec<&String> = constants
        .keys()
        .filter(|name| name.as_str() != "ALL" && !used.contains(*name))
        .collect();
    assert!(
        unused.is_empty(),
        "these categories are declared and documented and no log line uses them: {unused:?}.\n\
         Either something should be filed under them or they should be retired from \
         src/logcat.rs and docs/observability.md together."
    );
}

#[test]
fn the_walker_sees_a_line_with_no_target() {
    let bare = r#"
        fn f() {
            tracing::warn!(user = %id, "something happened");
        }
    "#;
    let found = invocations(&mask(bare));
    assert_eq!(found.len(), 1, "the walker did not find the call site at all");
    assert!(target_constant(&found[0].1).is_none(), "a line with no target was accepted");

    let tagged = r#"
        fn f() {
            tracing::warn!(target: crate::logcat::SCAN, user = %id, "something happened");
        }
    "#;
    let found = invocations(&mask(tagged));
    assert_eq!(found.len(), 1);
    assert_eq!(target_constant(&found[0].1).as_deref(), Some("SCAN"));

    let quoted = r#"
        /// Do not write tracing::warn!(category = "federation", ...) here.
        fn f() {
            let _ = "tracing::warn!(nope)";
        }
    "#;
    assert!(invocations(&mask(quoted)).is_empty(), "masking is not removing comments or strings");
}
