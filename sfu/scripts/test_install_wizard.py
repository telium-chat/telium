"""Regression tests for the privileged SFU installation chooser."""
import importlib.util
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
