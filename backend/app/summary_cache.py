"""Transactionally maintained monthly invoice summaries for PostgreSQL reporting.

Statement triggers cover ORM/API writes and bulk imports. All workspace writes
use the same advisory lock, so readers see an invoice and its summary together.
"""

from sqlalchemy import DDL, event

SUMMARY_DDL = """
SELECT pg_advisory_xact_lock(81726439);
CREATE OR REPLACE FUNCTION refresh_finance_monthly_summary() RETURNS void AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(81726439);
    DELETE FROM invoice_monthly_summaries;
    INSERT INTO invoice_monthly_summaries (customer_id, month_start, net, invoice_count)
    SELECT customer_id, date_trunc('month', period_start)::date,
           sum(subtotal - discount), count(*)
    FROM invoices WHERE state IN ('CONFIRMED', 'PAID')
    GROUP BY customer_id, date_trunc('month', period_start)::date;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION sync_finance_monthly_summary() RETURNS trigger AS $$
BEGIN
    PERFORM refresh_finance_monthly_summary();
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS finance_monthly_summary ON invoices;
CREATE TRIGGER finance_monthly_summary
AFTER INSERT OR UPDATE OR DELETE ON invoices
FOR EACH STATEMENT EXECUTE FUNCTION sync_finance_monthly_summary();
SELECT refresh_finance_monthly_summary();
"""


def register_summary_cache(metadata):
    event.listen(
        metadata, "after_create", DDL(SUMMARY_DDL).execute_if(dialect="postgresql")
    )
