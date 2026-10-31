"""Fail CI on credential files or recognizable private keys/tokens in tracked files.

This is a focused source check, not a claim of complete secret or vulnerability detection.
Only paths/line numbers are printed; matched credentials are never printed.
"""

from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
    rb"|ghp_[A-Za-z0-9]{36}"
    rb"|github_pat_[A-Za-z0-9_]{30,}"
)


def main():
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    failures = []
    for raw in tracked.split(b"\0"):
        if not raw:
            continue
        path = Path(raw.decode())
        source = ROOT / path
        if not source.is_file():
            continue
        if (
            path.name == ".env" or path.name.startswith(".env.")
        ) and path.name != ".env.example":
            failures.append(f"{path}: private environment file must not be tracked")
        content = source.read_bytes()
        if b"\0" in content:
            continue
        for number, line in enumerate(content.splitlines(), 1):
            if PATTERN.search(line):
                failures.append(
                    f"{path}:{number}: possible private key or GitHub token"
                )
    if failures:
        print("\n".join(failures))
        return 1
    print("Tracked-file credential check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
