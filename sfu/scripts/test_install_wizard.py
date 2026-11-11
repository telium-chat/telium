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


if __name__ == "__main__":
    unittest.main()
