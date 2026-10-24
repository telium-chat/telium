use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    io::Write,
    thread,
    time::Duration,
};
use wasapi::{DeviceEnumerator, Direction, SessionState};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    },
};

#[derive(Serialize)]
struct MediaSession {
    source_app_id: String,
    title: String,
    artist: String,
    album: String,
    media_type: &'static str,
    current: bool,
    process_id: u32,
    provider: &'static str,
    peak: f32,
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    if IsWindowVisible(hwnd) == 0 {
        return 1;
    }

    let length = GetWindowTextLengthW(hwnd);
    if length <= 0 {
        return 1;
    }

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == 0 {
        return 1;
    }

    let mut buffer = vec![0u16; length as usize + 1];
    let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
    if copied <= 0 {
        return 1;
    }

    let title = String::from_utf16_lossy(&buffer[..copied as usize])
        .trim()
        .to_string();
    if title.is_empty() {
        return 1;
    }

    let titles = &mut *(lparam as *mut HashMap<u32, Vec<String>>);
    titles.entry(pid).or_default().push(title);
    1
}

fn window_titles() -> HashMap<u32, Vec<String>> {
    let mut titles = HashMap::new();
    unsafe {
        let pointer = &mut titles as *mut HashMap<u32, Vec<String>> as LPARAM;
        let _ = EnumWindows(Some(collect_window), pointer);
    }
    titles
}

fn executable_from_pid(pid: u32) -> String {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return String::new();
        }

        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            0,
            buffer.as_mut_ptr(),
            &mut length,
        );
        let _ = CloseHandle(handle);
        if ok == 0 || length == 0 {
            return String::new();
        }

        let path = String::from_utf16_lossy(&buffer[..length as usize]);
        path.rsplit(['\\', '/']).next().unwrap_or_default().to_string()
    }
}

fn executable_from_identifier(identifier: &str) -> String {
    let normalized = identifier.replace('\\', "/");
    for part in normalized.rsplit('/') {
        let lower = part.to_ascii_lowercase();
        if let Some(end) = lower.find(".exe") {
            return part[..end + 4].to_string();
        }
    }
    String::new()
}

fn clean_source(raw: &str) -> String {
    raw.trim()
        .trim_matches(|c: char| c == '"' || c == '{' || c == '}')
        .to_string()
}

fn ignored_source(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    [
        "telium",
        "audiodg",
        "system sounds",
        "discord",
        "teams",
        "zoom",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn snapshot(
    enumerator: &DeviceEnumerator,
    windows: &HashMap<u32, Vec<String>>,
) -> Vec<MediaSession> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();

    let devices = match enumerator.get_device_collection(&Direction::Render) {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("[Telium Windows media] render devices: {error}");
            return result;
        }
    };

    for device in &devices {
        let device = match device {
            Ok(device) => device,
            Err(_) => continue,
        };
        let manager = match device.get_iaudiosessionmanager() {
            Ok(manager) => manager,
            Err(_) => continue,
        };
        let sessions = match manager.get_audiosessionenumerator() {
            Ok(sessions) => sessions,
            Err(_) => continue,
        };
        let count = sessions.get_count().unwrap_or(0);

        for index in 0..count {
            let session = match sessions.get_session(index) {
                Ok(session) => session,
                Err(_) => continue,
            };
            if session.get_state().ok() != Some(SessionState::Active) {
                continue;
            }

            let pid = match session.get_process_id() {
                Ok(pid) if pid != 0 && pid != std::process::id() => pid,
                _ => continue,
            };
            if !seen.insert(pid) {
                continue;
            }

            let identifier = session.get_session_identifier().unwrap_or_default();
            let display_name = session.get_display_name().unwrap_or_default();
            let process_executable = executable_from_pid(pid);
            let executable = if process_executable.is_empty() {
                executable_from_identifier(&identifier)
            } else {
                process_executable
            };
            let source = clean_source(if !executable.is_empty() {
                &executable
            } else if !display_name.is_empty() {
                &display_name
            } else {
                ""
            });
            if ignored_source(&source) {
                continue;
            }

            let title = windows
                .get(&pid)
                .and_then(|values| values.iter().max_by_key(|value| value.len()))
                .cloned()
                .unwrap_or_else(|| {
                    if !display_name.is_empty() {
                        display_name.clone()
                    } else if !source.is_empty() {
                        source.clone()
                    } else {
                        format!("Process {pid}")
                    }
                });

            let peak = session
                .get_audiometerinformation()
                .and_then(|meter| meter.get_peak_value())
                .unwrap_or(0.0);

            result.push(MediaSession {
                source_app_id: if source.is_empty() {
                    format!("pid-{pid}")
                } else {
                    source
                },
                title,
                artist: String::new(),
                album: String::new(),
                media_type: "unknown",
                current: false,
                process_id: pid,
                provider: "wasapi",
                peak,
            });
        }
    }

    result.sort_by(|left, right| {
        right
            .peak
            .partial_cmp(&left.peak)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(first) = result.first_mut() {
        first.current = true;
    }
    result
}

fn main() {
    if let Err(error) = wasapi::initialize_mta().ok() {
        eprintln!("[Telium Windows media] COM initialization: {error}");
        std::process::exit(2);
    }

    let enumerator = match DeviceEnumerator::new() {
        Ok(enumerator) => enumerator,
        Err(error) => {
            eprintln!("[Telium Windows media] audio device enumerator: {error}");
            std::process::exit(3);
        }
    };

    loop {
        let sessions = snapshot(&enumerator, &window_titles());
        match serde_json::to_string(&sessions) {
            Ok(line) => {
                println!("{line}");
                let _ = std::io::stdout().flush();
            }
            Err(error) => eprintln!("[Telium Windows media] JSON: {error}"),
        }
        thread::sleep(Duration::from_millis(1000));
    }
}
