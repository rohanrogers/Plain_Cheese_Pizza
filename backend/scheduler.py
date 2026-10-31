"""Run daily via cron, or manually; shares the HTTP billing transaction lock."""

import argparse
import json
import time
from datetime import date
from sqlalchemy import text
from .app.main import Base, engine, SessionLocal, audit
from .app.models import User, uid
from .app.billing import run_billing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--actor-id",
        required=True,
        help="Existing ADMIN or STAFF user ID for audit attribution",
    )
    parser.add_argument("--as-of", type=date.fromisoformat)
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Poll for due billing periods until stopped",
    )
    parser.add_argument("--poll-seconds", type=int, default=60)
    args = parser.parse_args()
    if args.poll_seconds < 1:
        parser.error("Poll interval must be positive")
    if args.serve and args.as_of:
        parser.error("Serve mode always follows the current date")
    Base.metadata.create_all(engine)
    while True:
        day = args.as_of or date.today()
        try:
            with SessionLocal.begin() as db:
                if engine.dialect.name == "postgresql":
                    db.execute(text("SELECT pg_advisory_xact_lock(81726439)"))
                else:
                    db.execute(text("BEGIN IMMEDIATE"))
                actor = db.get(User, args.actor_id)
                if not actor or actor.role not in ("ADMIN", "STAFF"):
                    parser.error("Actor must be an existing staff user")
                result = run_billing(db, day, True)
                if result["invoices_created"]:
                    audit(
                        db,
                        actor,
                        uid(),
                        "SCHEDULED_BILLING",
                        f"{day}: {result['invoices_created']} invoices",
                    )
            if not args.serve or result["invoices_created"]:
                print(json.dumps(result, default=str), flush=True)
        except Exception as exc:
            if not args.serve:
                raise
            print(f"Billing rolled back: {exc}", flush=True)
        if not args.serve:
            break
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    main()
