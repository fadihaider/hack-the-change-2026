import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("secret_scanner", Path(__file__).resolve().parents[2] / "tools/scan-tracked-secrets.py")
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class SecretScannerTests(unittest.TestCase):
    def test_locations_not_values_are_reported_in_tree_and_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            fixture_value = "AK" + "IA" + "A" * 16
            (root / "fixture.txt").write_text(fixture_value)
            subprocess.run(["git", "add", "fixture.txt"], cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=Security QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"], cwd=root, check=True)
            result = scanner.scan(root, history=True)
            self.assertEqual(result["status"], "REVIEW")
            self.assertEqual({f["source"] for f in result["findings"]}, {"tracked_tree", "git_history"})
            self.assertNotIn(fixture_value, json.dumps(result))

    def test_untracked_private_files_are_not_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / ".env.local").write_text("AK" + "IA" + "A" * 16)
            self.assertEqual(scanner.scan(root)["status"], "NO_MATCHES")


if __name__ == "__main__":
    unittest.main()
