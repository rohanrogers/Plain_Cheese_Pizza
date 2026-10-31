"""Idempotent data migrations, preserving existing finance records."""

from sqlalchemy import text
from sqlalchemy.orm import Session
from .models import SchemaMigration, AuthSession


def migrate_iam(engine):
    with Session(engine) as db, db.begin():
        if engine.dialect.name == "postgresql":
            db.execute(text("SELECT pg_advisory_xact_lock(81726439)"))
        if not db.get(SchemaMigration, "iam_v1_require_verified_sessions"):
            # Old password-only cookies must not bypass the new challenge flow.
            db.query(AuthSession).delete()
            db.add(SchemaMigration(revision="iam_v1_require_verified_sessions"))
