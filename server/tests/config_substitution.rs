
use std::path::{Path, PathBuf};

/// `set_var` races every other env read in the binary, so every test takes this.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("telium-subst-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn file(&self, name: &str, contents: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, contents).unwrap();
        path
    }
    fn config(&self, extra: &str) -> PathBuf {
        self.file("telium.toml", &format!("server_name = \"substitution.test.invalid\"\n{extra}\n"))
    }
    fn load(&self, extra: &str) -> anyhow::Result<telium_server::config::Config> {
        telium_server::config::Config::load(&self.config(extra))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn turn(value: &str) -> String {
    format!("[voice]\nturn = \"turn.example:3478\"\nturn_secret = \"{value}\"\n")
}
fn mail(value: &str) -> String {
    format!("[mail]\nwebhook_token = \"{value}\"\n")
}
fn file_ref(path: &Path) -> String {
    format!("${{file:{}}}", path.display())
}

#[test]
fn references_resolve_once_to_exactly_what_they_name() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Scratch::new("loads");
    std::env::set_var("TELIUM_TEST_SUBST_TURN", "not-a-real-turn-secret");
    std::env::set_var("TELIUM_TEST_SUBST_S3", "not-a-real-access-key-id");

    let token = dir.file("webhook.token", "  not-a-real-webhook-token \n\n");
    let cfg = dir.load(&format!("{}{}", turn("${env:TELIUM_TEST_SUBST_TURN}"), mail(&file_ref(&token)))).unwrap();
    assert_eq!(cfg.voice.turn_secret.as_deref(), Some("not-a-real-turn-secret"));
    assert_eq!(&*cfg.mail.webhook_token, "not-a-real-webhook-token", "surrounding whitespace is trimmed");

    let cfg = dir.load("[backup.remote]\naccess_key_id = \"${env:TELIUM_TEST_SUBST_S3}\"\n").unwrap();
    assert_eq!(&*cfg.backup.remote.access_key_id, "not-a-real-access-key-id", "nested tables are reached");

    let looped = dir.0.join("loop.token");
    std::fs::write(&looped, format!("{}\n", file_ref(&looped))).unwrap();
    let inner = dir.file("outer.token", "${env:TELIUM_TEST_SUBST_TURN}\n");
    for (value, expected) in [
        ("prefix-${env:TELIUM_TEST_SUBST_TURN}".to_string(), "prefix-${env:TELIUM_TEST_SUBST_TURN}".to_string()),
        ("not$a{real}password".into(), "not$a{real}password".into()),
        (file_ref(&inner), "${env:TELIUM_TEST_SUBST_TURN}".into()),
        (file_ref(&looped), file_ref(&looped)),
        ("secret".into(), "secret".into()),
        ("password".into(), "password".into()),
        ("token".into(), "token".into()),
        ("key".into(), "key".into()),
    ] {
        let cfg = dir.load(&mail(&value)).unwrap_or_else(|e| panic!("{value}: {e:#}"));
        assert_eq!(&*cfg.mail.webhook_token, expected.as_str());
    }
    std::env::remove_var("TELIUM_TEST_SUBST_TURN");
    std::env::remove_var("TELIUM_TEST_SUBST_S3");
}

#[test]
fn a_reference_that_cannot_resolve_refuses_the_start_and_says_why() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Scratch::new("refuse");
    std::env::remove_var("TELIUM_TEST_SUBST_ABSENT");
    std::env::set_var("TELIUM_TEST_SUBST_EMPTY", "");
    std::env::set_var("TELIUM_TEST_SUBST_PLACEHOLDER", "CHANGEME");
    let missing = dir.0.join("definitely-not-here");
    let blank = dir.file("blank.token", "\n   \n");

    let mut cases: Vec<(String, Vec<&str>)> = vec![
        (turn("${env:TELIUM_TEST_SUBST_ABSENT}"), vec!["telium_test_subst_absent", "voice.turn_secret"]),
        (turn("${env:TELIUM_TEST_SUBST_EMPTY}"), vec!["set but empty"]),
        (mail(&file_ref(&missing)), vec!["cannot be read"]),
        (mail(&file_ref(&blank)), vec!["empty"]),
        (mail("change-me"), vec!["mail.webhook_token"]),
        (mail("${env:TELIUM_TEST_SUBST_PLACEHOLDER}"), vec!["mail.webhook_token"]),
    ];
    for bad in ["${ENV:TELIUM_TEST_SUBST_X}", "${envfile:/run/secrets/x}", "${exec:id}", "${}"] {
        cases.push((mail(bad), vec!["not a reference this server understands", "${env:name}", "${file:"]));
    }
    #[cfg(unix)]
    let locked = {
        use std::os::unix::fs::PermissionsExt as _;
        let locked = dir.file("locked.token", "not-a-real-token");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read_to_string(&locked).is_err() {
            cases.push((mail(&file_ref(&locked)), vec!["cannot be read"]));
        }
        locked
    };
    for (extra, needles) in cases {
        let message = format!("{:#}", dir.load(&extra).expect_err(&extra)).to_lowercase();
        for needle in needles {
            assert!(message.contains(needle), "{extra}: missing {needle:?} in {message}");
        }
    }
    let message = format!("{:#}", dir.load(&mail(&file_ref(&missing))).unwrap_err()).to_lowercase();
    assert!(message.contains("mode 600") || message.contains("can read it"), "{message}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    std::env::remove_var("TELIUM_TEST_SUBST_EMPTY");
    std::env::remove_var("TELIUM_TEST_SUBST_PLACEHOLDER");
}

#[cfg(unix)]
#[test]
fn a_referenced_secret_file_is_audited_for_its_mode() {
    use std::os::unix::fs::PermissionsExt as _;
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Scratch::new("audit");
    let token = dir.file("turn.secret", "not-a-real-turn-secret\n");
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o644)).unwrap();
    let path = dir.config(&turn(&file_ref(&token)));
    let cfg = telium_server::config::Config::load(&path).expect("world-readable must not stop the server");

    let findings = telium_server::secrets::audit(&cfg, Some(&path));
    let found = findings.iter().find(|f| f.path == token).expect("a ${file:} target must be audited");
    assert!(!found.fatal);
    assert!(found.message.contains("chmod") && found.message.contains(&token.display().to_string()), "{}", found.message);

    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(telium_server::secrets::audit(&cfg, Some(&path)).iter().any(|f| f.path == token && f.fatal));
}
