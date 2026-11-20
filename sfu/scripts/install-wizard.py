#!/usr/bin/env python3
"""Local-only, one-time native SFU installer choice screen.

Runs as root because the selected installation backend must install services.
Never bind this privileged server to a non-loopback address. The bearer token
is printed on the server console; a remote operator uses SSH port forwarding.

The wizard listens on a fixed port next to the dashboard's (7892 and 7891), so
one SSH command forwarding both covers installation *and* the dashboard after
it: the operator never has to open a second tunnel.
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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# The dashboard's loopback port (admin.bind in sfu.toml, set by both install
# scripts) and the wizard's own, fixed so the tunnel can be opened up front.
DASHBOARD_PORT = 7891
WIZARD_PORT = 7892


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


def page(body, head=""):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">{head}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telium SFU setup</title>
<style>
:root{{color-scheme:dark;font-family:system-ui,sans-serif;background:#0c0d10;color:#f4f4f5}}
body{{max-width:720px;margin:48px auto;padding:0 20px;line-height:1.55}}
section{{border:1px solid #35353e;border-radius:14px;padding:20px;margin:18px 0;background:#15151b}}
label{{display:block;margin:12px 0}}input[type=text]{{display:block;width:100%;max-width:550px;
padding:11px;margin-top:6px;background:#22222a;color:#fff;border:1px solid #555;border-radius:8px}}
button{{background:#7c3aed;color:#fff;padding:12px 22px;border:0;border-radius:9px;font-weight:bold;cursor:pointer}}
small{{color:#aaa;display:block}}a.button{{display:inline-block;background:#7c3aed;color:#fff;padding:12px 22px;border-radius:9px;font-weight:bold;text-decoration:none}}pre{{white-space:pre-wrap;word-break:break-word;max-height:480px;overflow:auto;
border-radius:10px;padding:16px;background:#191920}}a{{color:#c4b5fd}}
</style></head><body><h1>Install Telium SFU</h1>{body}</body></html>"""


def tail(path, lines=70):
    try:
        with open(path, encoding="utf-8", errors="replace") as stream:
            return "".join(stream.readlines()[-lines:])
    except OSError:
        return ""


_IPV4 = re.compile(r"(?:\d{1,3}\.){3}\d{1,3}")


def ssh_target(environ=os.environ, lookup=None):
    """Best guess at `user@host` for the operator's ssh command.

    The user is whoever ran sudo; the host is the address their current SSH
    session reached (SSH_CONNECTION, if sudo kept it), else this machine's
    public IPv4. Placeholders stand in for anything unknown.
    """
    user = environ.get("SUDO_USER") or "USER"
    if not re.fullmatch(r"[A-Za-z0-9._-]+", user):
        user = "USER"
    host = ""
    connection = environ.get("SSH_CONNECTION", "").split()
    if len(connection) == 4:
        host = connection[2]
    if not host and lookup is not None:
        host = lookup()
    if not re.fullmatch(r"[0-9A-Fa-f:.]+", host or ""):
        host = "YOUR_SERVER"
    if ":" in host:
        host = f"[{host}]" if not host.startswith("[") else host
    return f"{user}@{host}"


def public_ipv4():
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=3) as response:
            value = response.read(64).decode("ascii", "replace").strip()
    except (OSError, ValueError):
        return ""
    return value if _IPV4.fullmatch(value) else ""


def tunnel_command(wizard_port, target):
    """One ssh command that forwards both the wizard and the dashboard."""
    forwards = [f"-L {DASHBOARD_PORT}:127.0.0.1:{DASHBOARD_PORT}"]
    if wizard_port != DASHBOARD_PORT:
        forwards.insert(0, f"-L {wizard_port}:127.0.0.1:{wizard_port}")
    return f"ssh -N {' '.join(forwards)} {target}"


_SETUP_TOKEN = re.compile(r"/admin\?token=([A-Za-z0-9_-]{16,})")


def setup_link(log_text):
    """The dashboard's one-time setup link, rewritten for the SSH tunnel.

    Both install scripts print the dashboard's bootstrap URL in some form
    (SERVER_IP:7891, the public IP behind a fresh Caddy, or localhost). The
    token is the only part that matters: the tunnel the operator already has
    open reaches the dashboard on localhost, which also keeps the token off
    plain HTTP to the public address.
    """
    matches = _SETUP_TOKEN.findall(log_text)
    if not matches:
        return None
    return f"http://localhost:{DASHBOARD_PORT}/admin?token={matches[-1]}"


def journal_text():
    try:
        return subprocess.run(
            ["journalctl", "-u", "telium-sfu", "-n", "200", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def admin_password_path(mode, directory):
    if mode == "portable" and directory:
        return Path(directory) / "data" / "state" / "admin-password"
    return Path("/var/lib/telium-sfu/state/admin-password")


def finished_state(log_text, mode, directory, journal=journal_text):
    """After a successful run: ("setup", link), ("kept", None) or ("starting", None).

    The scripts read the setup link from the journal two seconds after
    starting the service, which can be too early. Look again ourselves, and
    only call the install an update when the admin password really exists.
    """
    link = setup_link(log_text) or setup_link(journal())
    if link:
        return "setup", link
    if admin_password_path(mode, directory).exists():
        return "kept", None
    return "starting", None


def bind_wizard(handler):
    """Bind the fixed wizard port on loopback, or any free one if it is taken."""
    try:
        return ThreadingHTTPServer(("127.0.0.1", WIZARD_PORT), handler)
    except OSError:
        return ThreadingHTTPServer(("127.0.0.1", 0), handler)


def serve(source):
    token = secrets.token_urlsafe(32)
    state = {"mode": None, "directory": None, "returncode": None}
    lock = threading.Lock()
    fd, logfile = tempfile.mkstemp(prefix="telium-sfu-install-", suffix=".log")
    os.close(fd)

    class Handler(BaseHTTPRequestHandler):
        def send_html(self, body, code=200, head=""):
            data = page(body, head).encode()
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
            log_text = tail(logfile)
            log = html.escape(log_text)
            refresh = ""
            if rc is None:
                refresh = '<meta http-equiv="refresh" content="3">'
                status = "<h2>Installing…</h2><p>This page refreshes itself every few seconds.</p>"
            elif rc == 0:
                outcome, link = finished_state(_read(logfile), mode, directory)
                if outcome == "starting":
                    refresh = '<meta http-equiv="refresh" content="3">'
                    status = """<h2>Installation complete — the dashboard is starting…</h2>
<p>Its one-time setup link appears here as soon as the SFU has written it. This page refreshes itself.</p>"""
                elif outcome == "setup":
                    status = f"""<h2>Installation complete</h2>
<p>Next, set your admin password and enter your domains in the SFU dashboard. The SSH
tunnel you opened for this installer already reaches it.</p>
<p><a class="button" href="{html.escape(link)}">Continue to dashboard setup</a></p>
<small>This link works once. Later, open <code>http://localhost:{DASHBOARD_PORT}/admin</code> through the same
tunnel{" or <code>https://YOUR-SFU-DOMAIN/admin</code> once HTTPS is set up" if mode == "full" else ""}.</small>"""
                else:
                    status = f"""<h2>Installation complete</h2>
<p>Your existing dashboard and settings were kept. Open
<a href="http://localhost:{DASHBOARD_PORT}/admin">http://localhost:{DASHBOARD_PORT}/admin</a> through the same SSH tunnel.</p>"""
                if outcome != "starting":
                    status += "<p>You can close the installer with Ctrl+C in its terminal.</p>"
            else:
                status = f"<h2>Installation failed (exit {rc})</h2><p>Review the output below; you can safely rerun the installer after fixing prerequisites.</p>"
            self.send_html(f"{status}<p>Mode: <strong>{html.escape(mode)}</strong> {html.escape(directory or '')}</p><details{' open' if rc != 0 else ''}><summary>Installer output</summary><pre>{log}</pre></details>", head=refresh)

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
                            # The scripts then point at this page's Continue
                            # button instead of asking for a second tunnel.
                            env["TELIUM_SFU_FROM_WIZARD"] = "1"
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

    server = bind_wizard(Handler)
    port = server.server_port
    target = ssh_target(lookup=public_ipv4)
    url = f"http://localhost:{port}/?token={token}"
    print("\nTelium SFU installer is ready. Nothing on this machine has been changed yet.\n")
    print("1. On your own computer, open a terminal and run this one SSH tunnel.")
    print("   Keep it open: it serves this installer now and the SFU dashboard afterwards.")
    print(f"     {tunnel_command(port, target)}")
    print("   (Already connected with these -L options? Skip this step.)")
    print("2. Open this URL in your browser:")
    print(f"     {url}")
    print("\nKeep this terminal running until installation finishes. Ctrl+C closes the installer.\n", flush=True)
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
