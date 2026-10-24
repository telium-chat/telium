
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

const ERRCODES_SRC: &str = include_str!("../src/errcodes.rs");

const NAME_EXCEPTIONS: &[(&str, &str)] = &[("BOT_ASSERTION_REJECTED", "assertion_rejected")];

fn declarations() -> Vec<(String, String)> {
    let out: Vec<(String, String)> = ERRCODES_SRC
        .lines()
        .filter_map(|l| l.trim().strip_prefix("pub const "))
        .map(|rest| {
            let (name, rest) = rest.split_once(':').unwrap();
            let value = rest.split('"').nth(1).unwrap_or_else(|| panic!("no value in `{rest}`"));
            (name.trim().to_string(), value.to_string())
        })
        .collect();
    assert!(out.len() > 30, "only {} codes: the parse stopped matching the file", out.len());
    out
}

#[test]
fn every_code_is_well_formed_unique_registered_and_named_for_its_value() {
    const HEAD: &str = "const ALL: &[&str] = &[";
    let body = &ERRCODES_SRC[ERRCODES_SRC.find(HEAD).expect("errcodes.rs has no ALL list") + HEAD.len()..];
    let list = &body[..body.find("];").unwrap()];
    let registered: BTreeSet<String> = list
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .flat_map(|l| l.split(','))
        .map(|e| e.trim().trim_start_matches("super::").to_string())
        .filter(|e| !e.is_empty())
        .collect();
    let exceptions: BTreeMap<&str, &str> = NAME_EXCEPTIONS.iter().copied().collect();
    let mut seen = BTreeMap::new();
    let mut declared = BTreeSet::new();
    for (name, value) in declarations() {
        let snake = value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        assert!(snake && (1..=48).contains(&value.len()), "{name} = {value:?} must be short snake_case");
        assert!(!value.starts_with('_') && !value.ends_with('_'), "{name} = {value:?}");
        if let Some(first) = seen.insert(value.clone(), name.clone()) {
            panic!("{name} and {first} both send {value:?}");
        }
        assert!(registered.contains(&name), "{name} is not in ALL, so errcodes.rs never checks it");
        match exceptions.get(name.as_str()) {
            Some(expected) => assert_eq!(&value, expected, "{name}'s wire value changed"),
            None => assert_eq!(name, value.to_ascii_uppercase(), "name it for its value or add a NAME_EXCEPTION"),
        }
        declared.insert(name);
    }
    let stale: Vec<_> = registered.difference(&declared).collect();
    assert!(stale.is_empty(), "ALL names codes that no longer exist: {stale:?}");
}

#[test]
fn no_call_site_passes_a_literal_code() {
    fn walk(dir: &Path, offenders: &mut Vec<String>) {
        for path in std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()) {
            if path.is_dir() {
                walk(&path, offenders);
            } else if path.extension().is_some_and(|e| e == "rs") {
                for (n, line) in std::fs::read_to_string(&path).unwrap().lines().enumerate() {
                    if !line.trim_start().starts_with("//") && line.contains("with_code(\"") {
                        offenders.push(format!("{}:{}", path.display(), n + 1));
                    }
                }
            }
        }
    }
    let mut offenders = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut offenders);
    assert!(offenders.is_empty(), "pass a constant from errcodes.rs to with_code: {offenders:?}");
}
