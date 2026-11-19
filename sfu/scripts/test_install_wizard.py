"""Regression tests for the privileged SFU installation chooser."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "install_wizard", Path(__file__).with_name("install-wizard.py")
)
wizard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wizard)


class InstallChoiceTests(unittest.TestCase):
    def test_portable_path_is_dedicated(self):
        for path in ("/opt/telium-sfu", "/srv/relays/voice-1", "/opt/sfu_2"):
            self.assertEqual(wizard.validate_directory(path), path)

    def test_system_paths_and_traversal_cannot_be_selected(self):
        for path in (
            "/", "/etc", "/etc/nginx", "/usr/local/bin", "/var/lib/app",
            "/root/sfu", "relative", "/opt", "/srv", "/opt/../etc",
            "/opt/./telium", "/opt//telium", "/opt/a b", "/opt/a;rm",
        ):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    wizard.validate_directory(path)

    def test_html_uses_no_external_assets(self):
        document = wizard.page("<p>Choose mode</p>")
        self.assertIn("Choose mode", document)
        self.assertNotIn("http://", document)
        self.assertNotIn("https://", document)

    def test_portable_release_rejects_unsupported_or_unsigned_binaries(self):
        installer = Path(__file__).resolve().parents[1] / "install-portable.sh"
        source = installer.read_text()
        start = source.index("require_compatible_sfu() {")
        end = source.index("\n}\n", start) + len("\n}")
        guard = source[start:end]
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "sfubinary"
            for version_lines, expected in (
                ("portable_native_installer=1\npublisher_key_embedded=true\n", True),
                ("version=0.1.0\n", False),
                ("portable_native_installer=1\npublisher_key_embedded=false\n", False),
            ):
                binary.write_text("#!/bin/sh\nprintf '%s\\n' " + " ".join(repr(s) for s in version_lines.splitlines()) + "\n")
                binary.chmod(0o755)
                run = subprocess.run(
                    ["bash", "-c", guard + '\nrequire_compatible_sfu "$1"', "bash", str(binary)],
                    capture_output=True, text=True,
                )
                self.assertEqual(run.returncode == 0, expected, run.stderr)

    def test_portable_preflight_runs_before_host_changes(self):
        installer = (Path(__file__).resolve().parents[1] / "install-portable.sh").read_text()
        self.assertLess(
            installer.index('require_compatible_sfu "$tmp/telium-sfu"'),
            installer.index("useradd --system"),
        )
        self.assertIn('runuser -u telium-sfu -- mkdir -- "$target"', installer)
        self.assertNotIn('install -d -o telium-sfu -g telium-sfu -m 0750 "$PREFIX/data/state"', installer)
        self.assertIn('TELIUM_SFU_TRUSTED_NATIVE=1', installer)
        self.assertIn('TELIUM_SFU_EXAMPLE_CONFIG=', installer)


class OneTunnelTests(unittest.TestCase):
    def test_one_ssh_command_forwards_wizard_and_dashboard(self):
        command = wizard.tunnel_command(wizard.WIZARD_PORT, "alice@203.0.113.7")
        self.assertEqual(
            command,
            "ssh -N -L 7892:127.0.0.1:7892 -L 7891:127.0.0.1:7891 alice@203.0.113.7",
        )

    def test_ssh_target_prefers_the_current_ssh_session(self):
        env = {"SUDO_USER": "alice", "SSH_CONNECTION": "198.51.100.2 51234 203.0.113.7 22"}
        self.assertEqual(wizard.ssh_target(env, lookup=lambda: "192.0.2.1"), "alice@203.0.113.7")
        self.assertEqual(wizard.ssh_target({"SUDO_USER": "alice"}, lookup=lambda: "192.0.2.1"), "alice@192.0.2.1")
        self.assertEqual(wizard.ssh_target({}, lookup=lambda: ""), "USER@YOUR_SERVER")
        self.assertEqual(wizard.ssh_target({"SUDO_USER": "a;b"}, lookup=lambda: "x; rm"), "USER@YOUR_SERVER")
        env = {"SSH_CONNECTION": "2001:db8::2 51234 2001:db8::7 22", "SUDO_USER": "bob"}
        self.assertEqual(wizard.ssh_target(env), "bob@[2001:db8::7]")

    def test_setup_link_goes_through_the_tunnel_for_every_mode(self):
        token = "test-setup-token-000000000000000"
        for printed in (
            f"Open this one-time setup URL:\n  http://203.0.113.7/admin?token={token}\n",
            f"  http://localhost:7891/admin?token={token}\n",
            f"Then open: http://localhost:7891/admin?token={token}\n",
            f"FIRST-RUN SETUP: open http://SERVER_IP:7891/admin?token={token} and replace",
        ):
            with self.subTest(printed=printed):
                self.assertEqual(wizard.setup_link(printed), f"http://localhost:7891/admin?token={token}")
        self.assertIsNone(wizard.setup_link("Telium SFU was updated successfully."))

    def test_a_late_setup_link_is_not_mistaken_for_an_update(self):
        early = "Telium SFU started, but the setup URL was not found in the journal yet.\n"
        token = "test-setup-token-000000000000000"
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(
                wizard.finished_state(early, "portable", directory, journal=lambda: ""),
                ("starting", None),
            )
            late = f"FIRST-RUN SETUP: open http://SERVER_IP:7891/admin?token={token} and replace"
            self.assertEqual(
                wizard.finished_state(early, "portable", directory, journal=lambda: late),
                ("setup", f"http://localhost:7891/admin?token={token}"),
            )
            state = Path(directory) / "data" / "state"
            state.mkdir(parents=True)
            (state / "admin-password").write_text("x")
            self.assertEqual(
                wizard.finished_state("Telium SFU was updated successfully.", "portable", directory, journal=lambda: ""),
                ("kept", None),
            )

    def test_install_scripts_skip_the_second_tunnel_under_the_wizard(self):
        root = Path(__file__).resolve().parents[1]
        self.assertIn('TELIUM_SFU_FROM_WIZARD"] = "1"', Path(__file__).with_name("install-wizard.py").read_text())
        for script in ("install-full.sh", "install-portable.sh"):
            self.assertIn('TELIUM_SFU_FROM_WIZARD', (root / script).read_text())


if __name__ == "__main__":
    unittest.main()
