#!/usr/bin/env python3
"""Local-only, one-time native SFU installer choice screen.

Runs as root because the selected installation backend must install services.
Never bind this privileged server to a non-loopback address. The bearer token
is printed on the server console; a remote operator uses SSH port forwarding.
"""
import argparse
import html
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


def validate_directory(value):
    """Restrict privileged installation to a dedicated /opt or /srv subtree."""
    if not re.fullmatch(r"/(?:opt|srv)/[A-Za-z0-9._/-]+", value):
        raise ValueError("Choose an absolute directory under /opt or /srv.")
    if "//" in value:
        raise ValueError("Directory paths cannot contain repeated slashes.")
    parts = Path(value).parts
    if len(parts) < 3 or any(part in (".", "..") for part in value.split("/")):
        raise ValueError("Choose a dedicated directory, without . or .. components.")
    candidate = Path(value)
    for parent in (candidate, *candidate.parents):
        if parent.is_symlink():
            raise ValueError("The installation path cannot contain symlinks.")
    return value.rstrip("/")


PROXY_CHOICES = {
    "caddy-new": ("Install Caddy",
        "Nothing is using ports 80/443, so Caddy is installed and gets the HTTPS certificates itself "
        "(the same as the homeserver installer)."),
    "caddy-existing": ("Use your existing Caddy",
        "Caddy stays as it is. Telium adds one new file, /etc/caddy/telium-sfu.caddy, for its two sites."),
    "nginx-existing": ("Use your existing nginx",
        "nginx stays as it is: no default site is removed or replaced. Telium adds one new server file for "
        "its two hostnames and installs Certbot's nginx plugin to get certificates for those two names only."),
}


def detect_proxy(source):
    """Ask install-full.sh what is installed. Read-only: changes nothing."""
    script = source / "sfu" / "install-full.sh"
    try:
        out = subprocess.run(["bash", str(script), "--detect-proxy"], capture_output=True,
                             text=True, timeout=20, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return [], "", "Could not inspect this machine."
    values = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    options = [o for o in values.get("options", "").split(",") if o in PROXY_CHOICES]
    recommended = values.get("recommended", "")
    return options, recommended if recommended in options else "", values.get("note", "")


def full_section(source):
    options, recommended, note = detect_proxy(source)
    if not options:
        return f"""<section><strong>Full installation is not available</strong>
<small>{html.escape(note or "No supported HTTPS front end was found.")}</small></section>""", False
    radios = []
    for option in options:
        title, text = PROXY_CHOICES[option]
        checked = " checked" if option == recommended else ""
        suffix = " (recommended)" if option == recommended else ""
        radios.append(f"""<label><input type="radio" name="proxy" value="{option}"{checked}>
<strong>{html.escape(title)}</strong>{suffix}</label>
<small>{html.escape(text)}</small>""")
    extra = ""
    if "caddy-existing" in options:
        extra = """<label><input name="caddyfile_edit" type="checkbox" value="yes">
Existing Caddy only: add the line <code>import /etc/caddy/telium-sfu.caddy</code> to the end of my
/etc/caddy/Caddyfile. A backup is saved as Caddyfile.telium-sfu.bak first, and the change is rolled back
if Caddy rejects it. Without this the installer stops and tells you the line to add yourself.</label>"""
    return f"""<section><label><input type="radio" name="mode" value="full" checked>
<strong>Full installation — Telium manages the HTTPS front end</strong></label>
<small>Installs the packages it needs, systemd units, firewall rules where UFW is active, and automatic
updates. Existing web server configuration is never deleted or overwritten. Choose the HTTPS front end:</small>
{"".join(radios)}{extra}</section>""", True


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as stream:
            return stream.read()
    except OSError:
        return ""


def page(body):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telium SFU setup</title>
<style>
:root{{color-scheme:dark;font-family:system-ui,sans-serif;background:#0c0d10;color:#f4f4f5}}
body{{max-width:720px;margin:48px auto;padding:0 20px;line-height:1.55}}
section{{border:1px solid #35353e;border-radius:14px;padding:20px;margin:18px 0;background:#15151b}}
label{{display:block;margin:12px 0}}input[type=text]{{display:block;width:100%;max-width:550px;
padding:11px;margin-top:6px;background:#22222a;color:#fff;border:1px solid #555;border-radius:8px}}
button{{background:#7c3aed;color:#fff;padding:12px 22px;border:0;border-radius:9px;font-weight:bold;cursor:pointer}}
small{{color:#aaa;display:block}}pre{{white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto;
border-radius:10px;padding:16px;background:#191920}}a{{color:#c4b5fd}}
</style></head><body><h1>Install Telium SFU</h1>{body}</body></html>"""


def tail(path, lines=70):
    try:
        with open(path, encoding="utf-8", errors="replace") as stream:
            return "".join(stream.readlines()[-lines:])
    except OSError:
        return ""


def serve(source):
    token = secrets.token_urlsafe(32)
    state = {"mode": None, "directory": None, "returncode": None}
    lock = threading.Lock()
    fd, logfile = tempfile.mkstemp(prefix="telium-sfu-install-", suffix=".log")
    os.close(fd)

    class Handler(BaseHTTPRequestHandler):
        def send_html(self, body, code=200):
            data = page(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            return parse_qs(urlsplit(self.path).query).get("token") == [token]

        def do_GET(self):
            if not self.allowed():
                self.send_html("<p>Use the one-time installer URL printed in your terminal.</p>", 403)
                return
            with lock:
                mode, rc, directory = state["mode"], state["returncode"], state["directory"]
            if mode is None:
                full_html, full_ok = full_section(source)
                self.send_html(f"""
<p>Choose how this machine should host the SFU. Nothing has been installed yet.</p>
<form method="post" action="/choose?token={token}">
{full_html}
<section><label><input type="radio" name="mode" value="portable"{"" if full_ok else " checked"}>
<strong>Portable native installation — shared machine</strong></label>
<small>SFU, LiveKit, config, updater and state stay in one folder. Reuses your existing HTTPS
reverse proxy; does not change nginx or firewall settings. Only a dedicated service
account and three small systemd units are installed outside the folder.</small>
<label>Installation directory
<input name="directory" type="text" value="/opt/telium-sfu"></label>
<small>Use a dedicated path under /opt or /srv. This path must not contain symlinks.</small></section>
<label><input name="confirm" type="checkbox" value="yes" required>
I understand the selected installation will make the system changes described above.</label>
<button type="submit">Install selected mode</button></form>""")
                return
            log = html.escape(tail(logfile))
            if rc is None:
                status = "<h2>Installing…</h2><p>Refresh this page to check progress.</p>"
            elif rc == 0:
                status = "<h2>Installation complete</h2><p>Follow the one-time SFU dashboard URL in the log below to set your admin password and finish configuration.</p>"
                if mode == "portable":
                    status += "<p>For remote access to the portable dashboard, use <code>ssh -L 7891:127.0.0.1:7891 user@server</code> and replace SERVER_IP in the printed URL with localhost.</p>"
            else:
                status = f"<h2>Installation failed (exit {rc})</h2><p>Review the output below; you can safely rerun the installer after fixing prerequisites.</p>"
            self.send_html(f"{status}<p>Mode: <strong>{html.escape(mode)}</strong> {html.escape(directory or '')}</p><pre>{log}</pre><p><a href='/?token={token}'>Refresh status</a></p>")

        def do_POST(self):
            if not self.allowed() or urlsplit(self.path).path != "/choose":
                self.send_html("<p>Invalid or expired setup link.</p>", 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    raise ValueError("Invalid form size.")
                params = parse_qs(self.rfile.read(length).decode("utf-8"), keep_blank_values=True)
                mode = params.get("mode", [""])[0]
                if mode not in ("full", "portable") or params.get("confirm") != ["yes"]:
                    raise ValueError("Choose an installation mode and confirm the changes.")
                directory = validate_directory(params.get("directory", [""])[0]) if mode == "portable" else None
                proxy = params.get("proxy", [""])[0] if mode == "full" else ""
                if mode == "full":
                    if proxy not in detect_proxy(source)[0]:
                        raise ValueError("Choose one of the HTTPS front ends offered for this machine.")
                    # An existing Caddyfile is only edited with explicit consent.
                    if (proxy == "caddy-existing" and params.get("caddyfile_edit") != ["yes"]
                            and not Path("/etc/telium/sfu-proxy").exists()
                            and "import /etc/caddy/telium-sfu.caddy" not in _read("/etc/caddy/Caddyfile")):
                        raise ValueError("To use your existing Caddy, tick the box that allows adding one import line to your Caddyfile, or choose the portable installation.")
                with lock:
                    if state["mode"] is not None:
                        raise ValueError("Installation already started.")
                    state["mode"], state["directory"] = mode, directory
                command = ["bash", str(source / "sfu" / ("install-full.sh" if mode == "full" else "install-portable.sh"))]
                if directory:
                    command.append(directory)
                def launch():
                    try:
                        with open(logfile, "a", encoding="utf-8") as output:
                            env = dict(os.environ)
                            if proxy:
                                env["TELIUM_SFU_PROXY"] = proxy
                                if params.get("caddyfile_edit") == ["yes"]:
                                    env["TELIUM_SFU_CADDYFILE_EDIT"] = "yes"
                            rc = subprocess.call(command, cwd=source, stdout=output, stderr=subprocess.STDOUT, env=env)
                    except OSError as exc:
                        with open(logfile, "a", encoding="utf-8") as output:
                            output.write(str(exc) + "\n")
                        rc = 1
                    with lock:
                        state["returncode"] = rc
                threading.Thread(target=launch, daemon=True).start()
                self.send_response(303)
                self.send_header("Location", f"/?token={token}")
                self.send_header("Content-Length", "0")
                self.end_headers()
            except (ValueError, UnicodeError) as exc:
                self.send_html(f"<p>{html.escape(str(exc))}</p><p>Return to the installer and try again.</p>", 400)

        def log_message(self, format, *args):
            pass  # Do not log bearer tokens to the console/journal.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_port
    print("\nTelium SFU local web installer")
    print("No packages, services, nginx sites or firewall rules have been changed.")
    print(f"Open on this machine: http://127.0.0.1:{port}/?token={token}")
    print("For SSH access from your own computer, open another terminal and run:")
    print(f"  ssh -L {port}:127.0.0.1:{port} USER@YOUR_SERVER")
    print("Then open the localhost URL above in your browser.")
    print("Keep this terminal running until installation finishes. Ctrl+C closes the wizard.\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSetup wizard stopped.")
    finally:
        server.server_close()
        os.unlink(logfile)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("run with sudo/root")
    serve(args.source_root.resolve())
