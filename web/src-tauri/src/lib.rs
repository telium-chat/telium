use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "linux")]
fn configure_system_gstreamer() {
    let candidates = [
        "/usr/lib/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
    ];
    let paths = candidates
        .iter()
        .filter(|path| std::path::Path::new(path).is_dir())
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        return;
    }
    let existing = std::env::var_os("GST_PLUGIN_PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut all_paths = paths;
    all_paths.extend(existing);
    if let Ok(value) = std::env::join_paths(all_paths) {
        std::env::set_var("GST_PLUGIN_PATH", value);
    }
}

/// Open an HTTP(S) URL through the desktop's default handler. The opener
/// plugin uses a detached `xdg-open` process on Linux, which can report that it
/// started even when its desktop-specific handler immediately crashes. Using
/// Gio first lets the desktop portal choose the user's actual default browser
/// and gives us a real exit status for the UI to report.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only HTTP(S) links can be opened externally.".into());
    }

    #[cfg(target_os = "linux")]
    {
        let attempts = [
            ("gio", vec!["open", url.as_str()]),
            ("xdg-open", vec![url.as_str()]),
            ("kde-open", vec!["--", url.as_str()]),
        ];
        let mut errors = Vec::new();
        for (program, args) in attempts {
            match std::process::Command::new(program).args(args).status() {
                Ok(status) if status.success() => return Ok(()),
                Ok(status) => errors.push(format!("{program} exited with {status}")),
                Err(error) => errors.push(format!("{program}: {error}")),
            }
        }
        return Err(format!("Could not open URL: {}", errors.join("; ")));
    }

    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("open")
            .arg(&url)
            .status()
            .map_err(|error| format!("open: {error}"))
            .and_then(|status| {
                if status.success() { Ok(()) } else { Err(format!("open exited with {status}")) }
            });
    }

    #[cfg(target_os = "windows")]
    {
        return std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .status()
            .map_err(|error| format!("start: {error}"))
            .and_then(|status| {
                if status.success() { Ok(()) } else { Err(format!("start exited with {status}")) }
            });
    }

    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        Err("Desktop URL opening is not available on mobile.".into())
    }
}

#[tauri::command]
fn notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    app.notification()
        .permission_state()
        .map(|state| state.to_string())
        .map_err(|error| format!("Could not read notification permission: {error}"))
}

#[tauri::command]
fn request_notification_permission(app: tauri::AppHandle) -> Result<String, String> {
    app.notification()
        .request_permission()
        .map(|state| state.to_string())
        .map_err(|error| format!("Could not request notification permission: {error}"))
}

#[tauri::command]
fn show_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    // Gateway payloads are user-controlled. Keep notification-daemon payloads
    // small even if a malformed server sends an unexpectedly large field.
    let title = title.chars().take(160).collect::<String>();
    let body = body.chars().take(1024).collect::<String>();
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("Could not show notification: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validate_gofile_download_url(raw: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw).map_err(|_| "Gofile URL is invalid.".to_string())?;
    let host = parsed.host_str().unwrap_or_default();
    let gofile = host == "gofile.io" || host.ends_with(".gofile.io");
    if parsed.scheme() != "https"
        || !gofile
        || !parsed.path().starts_with("/download/")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Gofile playback only accepts HTTPS gofile.io download URLs.".into());
    }
    Ok(parsed)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validate_gofile_guest_token(token: &str) -> Result<(), String> {
    if !(16..=2048).contains(&token.len())
        || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("Gofile returned an invalid guest token.".into());
    }
    Ok(())
}

/// Give the desktop webview its disposable Gofile viewer cookie. The media
/// element still points at the original Gofile URL, so bytes travel directly
/// from Gofile into WebKit/WebView2/WKWebView rather than through Telium.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn prepare_gofile_playback(
    app: tauri::AppHandle,
    source: String,
    token: String,
) -> Result<(), String> {
    use tauri::Manager;

    validate_gofile_download_url(&source)?;
    validate_gofile_guest_token(&token)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Telium webview is unavailable.".to_string())?;
    let cookie = tauri::webview::Cookie::build(("accountToken", token))
        .domain("gofile.io")
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(tauri::webview::cookie::SameSite::None)
        .build();
    window
        .set_cookie(cookie)
        .map_err(|error| format!("Could not prepare Gofile playback cookie: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_private_or_special_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let octets = v4.octets();
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || octets[0] == 0
                || octets[0] >= 240
                || (octets[0] == 100 && (64..128).contains(&octets[1]))
                || (octets[0] == 198 && (18..20).contains(&octets[1]))
        }
        std::net::IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || v6.to_ipv4_mapped().is_some_and(|v4| {
                    is_private_or_special_ip(std::net::IpAddr::V4(v4))
                })
        }
    }
}

/// Fetch GIF bytes for the desktop-controlled animation clock.
///
/// This deliberately does not become a general native fetch primitive:
/// HTTPS only, no redirects or system proxy, DNS is checked then pinned,
/// private/special networks are refused, GIF signatures are verified, and the
/// compressed response is capped at 20 MiB.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
async fn fetch_gif_bytes(url: String) -> Result<String, String> {
    use base64::Engine;
    use std::net::ToSocketAddrs;

    const MAX_GIF_BYTES: u64 = 20 * 1024 * 1024;

    let parsed = reqwest::Url::parse(&url).map_err(|_| "GIF URL is invalid.".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Desktop GIF playback only fetches HTTPS URLs.".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "GIF URL has no host.".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);

    let addrs = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "GIF host could not be resolved.".to_string())?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("GIF host could not be resolved.".into());
    }
    if addrs.iter().any(|addr| is_private_or_special_ip(addr.ip())) {
        return Err("GIF host resolves to a private or special network address.".into());
    }

    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addrs)
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("Telium/0.1 desktop-gif-player")
        .build()
        .map_err(|error| format!("Could not create GIF client: {error}"))?;

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|error| format!("Could not fetch GIF: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("GIF host returned HTTP {}.", response.status()));
    }
    if response.content_length().is_some_and(|size| size > MAX_GIF_BYTES) {
        return Err("GIF is too large for controlled playback.".into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read GIF: {error}"))?;
    if bytes.len() as u64 > MAX_GIF_BYTES {
        return Err("GIF is too large for controlled playback.".into());
    }
    if !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Err("The fetched resource is not a GIF.".into());
    }

    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod gofile_tests {
    use super::{validate_gofile_download_url, validate_gofile_guest_token};

    #[test]
    fn accepts_only_gofile_download_urls() {
        assert!(validate_gofile_download_url(
            "https://store-na-phx-5.gofile.io/download/web/file/movie.mp4"
        )
        .is_ok());
        assert!(validate_gofile_download_url(
            "https://evilgofile.io/download/web/file/movie.mp4"
        )
        .is_err());
        assert!(validate_gofile_download_url("https://gofile.io/d/share-code").is_err());
        assert!(validate_gofile_download_url(
            "http://store1.gofile.io/download/web/file/movie.mp4"
        )
        .is_err());
    }

    #[test]
    fn rejects_tokens_that_could_escape_a_cookie_value() {
        assert!(validate_gofile_guest_token("abcdefghijklmnopqrstuvwxyz123456").is_ok());
        assert!(validate_gofile_guest_token("short").is_err());
        assert!(validate_gofile_guest_token("valid-looking-token; Domain=evil.test").is_err());
        assert!(validate_gofile_guest_token("unicode-å-token-abcdefghijklmnop").is_err());
    }
}

#[cfg(target_os = "linux")]
fn configure_bundled_gstreamer() {
    // AppImage's GTK hook can expose its Python installation to child
    // processes. GStreamer does not need Python for native media playback,
    // and gst-plugin-scanner must not inherit an incomplete PYTHONHOME.
    for variable in ["PYTHONHOME", "PYTHONPATH", "PYTHONEXECUTABLE"] {
        std::env::remove_var(variable);
    }

    let mut candidates = Vec::new();
    if let Some(app_dir) = std::env::var_os("APPDIR") {
        let app_dir = std::path::PathBuf::from(app_dir);
        candidates.push(app_dir.join("usr/lib/Telium/gstreamer-1.0"));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(bin_dir) = executable.parent() {
            candidates.push(bin_dir.join("../lib/Telium/gstreamer-1.0"));
            candidates.push(bin_dir.join("../lib/telium-desktop/resources/gstreamer-1.0"));
            candidates.push(bin_dir.join("resources/gstreamer-1.0"));
        }
    }
    let Some(plugin_dir) = candidates.into_iter().find(|path| path.is_dir()) else { return };
    let existing = std::env::var_os("GST_PLUGIN_PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut all_paths = vec![plugin_dir.clone()];
    all_paths.extend(existing);
    if let Ok(value) = std::env::join_paths(all_paths) {
        std::env::set_var("GST_PLUGIN_PATH", value);
        std::env::set_var("GST_PLUGIN_PATH_1_0", &plugin_dir);
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &plugin_dir);
    }
    let scanner = plugin_dir.join("gst-plugin-scanner");
    if scanner.is_file() {
        std::env::set_var("GST_PLUGIN_SCANNER", &scanner);
        std::env::set_var("GST_PLUGIN_SCANNER_1_0", scanner);
    }
    std::env::set_var("GST_REGISTRY_REUSE_PLUGIN_SCANNER", "no");
}

#[cfg(target_os = "linux")]
fn configure_linux_media_permissions(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::Manager;
    use webkit2gtk::{glib::prelude::*, PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    // The WebView exists by the time setup runs, while the permission request
    // signal must be connected before JavaScript asks for the microphone. The
    // native handler is deliberately limited to user-media requests; other
    // WebKit permissions retain their normal behavior.
    window.with_webview(|webview| {
        let inner = webview.inner();
        inner.connect_permission_request(|_, request| {
            if request.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                request.allow();
                true
            } else {
                false
            }
        });
    })?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    configure_system_gstreamer();
    #[cfg(target_os = "linux")]
    configure_bundled_gstreamer();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_external_url,
        notification_permission,
        request_notification_permission,
        show_native_notification,
        fetch_gif_bytes,
        prepare_gofile_playback,
    ]);
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        open_external_url,
        notification_permission,
        request_notification_permission,
        show_native_notification,
    ]);

    builder
        .setup(|app| {
            #[cfg(target_os = "linux")]
            configure_linux_media_permissions(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Telium");
}
