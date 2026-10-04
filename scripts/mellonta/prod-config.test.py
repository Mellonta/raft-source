import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("prod_config", Path(__file__).with_name("prod-config.py"))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ProductionConfigTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "source with spaces"
        self.root = Path(self.directory.name) / "data with $literal"
        self.source.mkdir()
        self.root.mkdir()
        (self.root / "postgres").mkdir()
        (self.source / ".node-version").write_text("24.15.0\n")
        self.git = patch.object(config.subprocess, "check_output", return_value="a" * 40)
        self.git.start()
        self.addCleanup(self.git.stop)

    def configure(self, **kwargs):
        config.configure(self.source, self.root, **kwargs)

    def test_rerun_keeps_credentials_and_operator_settings(self):
        self.configure(public_url="http://raft.example:8080")
        first = json.loads((self.root / "settings.json").read_text())
        (self.root / "postgres" / "PG_VERSION").write_text("16")
        extra = self.root / "server-extra.env"
        extra.write_text("FROM_EMAIL=Raft <raft@example.com>\n")
        self.configure(public_url="https://raft.example", bind="127.0.0.1")
        second = json.loads((self.root / "settings.json").read_text())
        for key in ("postgres_password", "jwt_secret", "bootstrap_pepper", "mcp_key"):
            self.assertEqual(first[key], second[key])
        self.assertIn("FROM_EMAIL=", extra.read_text())
        self.assertEqual((self.root / "settings.json").stat().st_mode & 0o777, 0o600)
        compose = json.loads((self.root / "compose.json").read_text())
        for service in ("postgres", "redis", "server", "migrate"):
            self.assertNotIn("ports", compose["services"][service])
        self.assertEqual(compose["services"]["web"]["ports"][0]["host_ip"], "127.0.0.1")
        self.assertIn("$$literal", compose["services"]["server"]["volumes"][0]["source"])

    def test_invalid_origin_or_bind_does_not_replace_working_configuration(self):
        self.configure(public_url="https://raft.example")
        original = (self.root / "compose.json").read_bytes()
        for url in ("https://user:secret@raft.example", "https://raft.example/path", "file:///tmp/a", "https://x/$(whoami)"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.configure(public_url=url)
            self.assertEqual((self.root / "compose.json").read_bytes(), original)
        with self.assertRaises(ValueError):
            self.configure(bind="arbitrary-host")
        self.assertEqual((self.root / "compose.json").read_bytes(), original)

    def test_missing_secrets_on_populated_database_are_not_regenerated(self):
        (self.root / "postgres" / "PG_VERSION").write_text("16")
        with self.assertRaisesRegex(ValueError, "restore its original secrets"):
            self.configure(public_url="https://raft.example")
        self.assertFalse((self.root / "settings.json").exists())

    def test_help_needs_no_docker_or_linux(self):
        # Help can be inspected safely on the Mac before deployment.
        result = subprocess.run(["bash", str(Path(__file__).with_name("deploy-prod.sh")), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Docker configuration is untouched", result.stdout)


if __name__ == "__main__":
    unittest.main()
