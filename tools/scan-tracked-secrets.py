#!/usr/bin/env python3
"""Scan tracked text and optional Git diffs; print locations/rules, never values."""
import argparse
import json
from pathlib import Path
import re
import subprocess

PATTERNS = {
    "aws_access_key_id": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "google_client_secret": re.compile(r"GOCSPX-[A-Za-z0-9_-]{20,}"),
    "openai_project_key": re.compile(r"sk-proj-[A-Za-z0-9_-]{30,}"),
    "literal_secret_assignment": re.compile(r"(?:AWS_SECRET_ACCESS_KEY|GOOGLE_CLIENT_SECRET|ELEVENLABS_API_KEY|AUTH_SECRET|APP_ENC_KEY)\s*[:=]\s*[\"']?[A-Za-z0-9_+/=-]{24,}"),
}


def scan(root, history=False):
    findings = []
    files = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
    for name in filter(None, files):
        path = root / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            for rule, pattern in PATTERNS.items():
                if pattern.search(line):
                    findings.append({"source": "tracked_tree", "path": name, "line": number, "rule": rule})
    if history:
        diff = subprocess.check_output(["git", "log", "--all", "--format=commit:%H", "-p", "--no-ext-diff"], cwd=root).decode("utf-8", errors="replace")
        commit, path, seen = "", "", set()
        for line in diff.splitlines():
            if line.startswith("commit:"):
                commit = line[7:]
            elif line.startswith("+++ b/"):
                path = line[6:]
            elif line.startswith("+") and not line.startswith("+++"):
                for rule, pattern in PATTERNS.items():
                    key = (commit, path, rule)
                    if pattern.search(line) and key not in seen:
                        findings.append({"source": "git_history", "commit": commit, "path": path, "rule": rule})
                        seen.add(key)
    return {"status": "REVIEW" if findings else "NO_MATCHES", "findings": findings,
            "limits": "Heuristic scan of tracked text and added diff lines only; not proof that no secrets exist. Values are never emitted. Untracked/local env files are intentionally excluded."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--history", action="store_true")
    args = parser.parse_args()
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
    report = scan(root, args.history)
    print(json.dumps(report, indent=2))
    raise SystemExit(1 if report["findings"] else 0)
