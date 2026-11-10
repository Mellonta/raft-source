import importlib.util
import fcntl
import json
import os
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
        self.root = Path(self.directory.name) / "Raft's data with $literal"
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
        for service in ("postgres", "redis", "risingwave", "server", "migrate", "rw-bootstrap"):
            self.assertNotIn("ports", compose["services"][service])
        self.assertTrue(compose["networks"]["reads"]["internal"])
        self.assertEqual(compose["services"]["risingwave"]["networks"], ["reads"])
        self.assertEqual(compose["services"]["risingwave"]["environment"]["ENABLE_TELEMETRY"], "false")
        self.assertIn("wal_level=logical", compose["services"]["postgres"]["command"])
        self.assertEqual(compose["services"]["server"]["environment"]["RISINGWAVE_DATABASE_URL"],
                         compose["services"]["rw-bootstrap"]["environment"]["RISINGWAVE_DATABASE_URL"])
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

    def test_separate_directories_isolate_mounts_projects_and_images(self):
        self.configure(public_url="http://raft.example:8001")
        other = self.root.parent / "other"
        (other / "postgres").mkdir(parents=True)
        config.configure(self.source, other, public_url="http://other.example:8002")
        projects, images = [], []
        for root in (self.root, other):
            compose = json.loads((root / "compose.json").read_text())
            services = compose["services"]
            projects.append(compose["name"])
            images.append(services["server"]["image"])
            self.assertEqual(services["migrate"]["image"], images[-1])
            for service, directory in (("postgres", "postgres"), ("redis", "redis"), ("risingwave", "risingwave"), ("server", "uploads")):
                mount = services[service]["volumes"][0]["source"]
                self.assertEqual(mount.replace("$$", "$"), str(root.resolve() / directory))
        self.assertNotEqual(*projects)
        self.assertNotEqual(*images)
        self.configure()
        self.assertEqual(json.loads((self.root / "compose.json").read_text())["name"], projects[0])

    def test_saved_launchers_use_selected_directory_from_any_working_directory(self):
        self.configure(public_url="http://raft.example:8001")
        deploy = self.source / "scripts/mellonta/deploy-prod.sh"
        deploy.parent.mkdir(parents=True)
        deploy.write_text('printf "%s\\n" "$RAFT_PROD_STATE_DIR" "$@"\n')
        env = {**os.environ, "RAFT_PROD_STATE_DIR": "/an/unrelated/deployment"}
        for launcher, args, expected in (("start.sh", [], ["start"]), ("raftprod", ["logs", "web"], ["logs", "web"])):
            result = subprocess.run(["bash", str(self.root / launcher), *args], check=True,
                                    env=env, cwd=self.source, capture_output=True, text=True)
            self.assertEqual(result.stdout.splitlines(), [str(self.root.resolve()), *expected])

    @unittest.skipUnless(sys.platform.startswith("linux"), "deployment requires Linux")
    def test_cli_directory_precedence_for_existing_deployment(self):
        self.configure(public_url="http://raft.example:8001")
        docker = self.source / "docker"
        docker.write_text('#!/bin/sh\nprintf "%s\\n" "$@" >> "$CALLS"\n')
        docker.chmod(0o755)
        calls = self.source / "calls"
        env = {**os.environ, "PATH": str(self.source) + ":" + os.environ["PATH"], "CALLS": str(calls)}
        script = str(Path(__file__).with_name("deploy-prod.sh").resolve())
        with (self.root / "deploy.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            for args, configured, last in ((["--state-dir", str(self.root), "status"], self.source, "ps"),
                                           (["status", "--state-dir", str(self.root)], self.source, "ps"),
                                           (["logs", "web"], self.root, "web")):
                calls.write_text("")
                subprocess.run(["bash", script, *args], cwd=self.source, check=True,
                               env={**env, "RAFT_PROD_STATE_DIR": str(configured)})
                arguments = calls.read_text().splitlines()
                self.assertEqual(arguments[arguments.index("-f") + 1], str(self.root.resolve() / "compose.json"))
                self.assertEqual(arguments[-1], last)
            busy = subprocess.run(["bash", script, "stop"], capture_output=True, text=True,
                                  env={**env, "RAFT_PROD_STATE_DIR": str(self.root)})
            self.assertNotEqual(busy.returncode, 0)
            self.assertIn("Another production operation", busy.stderr)

    @unittest.skipUnless(sys.platform.startswith("linux"), "deployment requires Linux")
    def test_deploy_prepares_user_owned_state_without_sudo(self):
        target = self.root / "new state"
        scripts = Path(__file__).resolve().parent
        docker = self.source / "docker"
        docker.write_text('#!/bin/sh\ncase "$*" in *"build server web") exit 42;; esac\n')
        docker.chmod(0o755)
        sudo = self.source / "sudo"
        sudo.write_text('#!/bin/sh\nexit 99\n')
        sudo.chmod(0o755)
        # Fail the build after the real script has prepared its directories.
        env = {**os.environ, "PATH": str(self.source) + ":" + os.environ["PATH"]}
        deploy = ["bash", str(scripts / "deploy-prod.sh"), "--state-dir", str(target),
                  "--url", "http://raft.example", "--port", "80"]
        result = subprocess.run(deploy, capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 42, result.stderr)
        self.assertFalse((target / "settings.json").exists())
        for directory in ("postgres", "redis", "risingwave", "uploads", "backups"):
            self.assertTrue((target / directory).is_dir())
        config.configure(self.source, target, public_url="http://raft.example:8001")
        original = {f: (target / f).read_bytes() for f in ("settings.json", "compose.json", "start.sh", "raftprod")}
        result = subprocess.run(deploy, capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 42, result.stderr)
        for file, contents in original.items():
            self.assertEqual((target / file).read_bytes(), contents)
        self.assertEqual(list(target.glob(".deploy.*")), [])

    def test_http_url_port_is_published_and_repairs_previously_mismatched_settings(self):
        self.configure(public_url="http://raft.example:8001", port=8080)
        before = json.loads((self.root / "settings.json").read_text())
        self.configure(public_url="http://raft.example:8001")
        settings = json.loads((self.root / "settings.json").read_text())
        compose = json.loads((self.root / "compose.json").read_text())
        self.assertEqual(settings["port"], 8001)
        self.assertEqual(compose["services"]["web"]["ports"][0]["published"], "8001")
        self.assertEqual(compose["services"]["server"]["environment"]["SERVER_URL"], settings["public_url"])
        self.assertEqual(settings["jwt_secret"], before["jwt_secret"])
        self.configure()
        self.assertEqual(json.loads((self.root / "settings.json").read_text())["port"], 8001)

    def test_explicit_port_and_https_reverse_proxy_settings_are_preserved(self):
        self.configure(public_url="http://raft.example:8001", port=18080)
        self.assertEqual(json.loads((self.root / "settings.json").read_text())["port"], 18080)
        self.configure(public_url="https://raft.example:8443")
        self.assertEqual(json.loads((self.root / "settings.json").read_text())["port"], 18080)

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
