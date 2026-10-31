"""Prepare private local configuration without printing or replacing secrets."""

import os
from pathlib import Path
from dotenv import dotenv_values, set_key
from cryptography.fernet import Fernet


def main():
    root = Path(__file__).resolve().parents[1]
    target = root / ".env"
    if not target.exists():
        target.write_text((root / ".env.example").read_text())
    values = dotenv_values(target)
    existing = values.get("MFA_ENCRYPTION_KEY")
    if existing:
        Fernet(existing.encode())
    else:
        set_key(target, "MFA_ENCRYPTION_KEY", Fernet.generate_key().decode())
    os.chmod(target, 0o600)
    print(
        "Local .env is configured. Existing secrets were preserved; the authenticator key is not printed."
    )


if __name__ == "__main__":
    main()
