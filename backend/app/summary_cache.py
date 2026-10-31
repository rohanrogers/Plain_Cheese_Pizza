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
    -- Draft/cancelled documents contribute nothing to the issued-revenue cache.
    -- Transition tables let us check the affected statement once, including bulk
    -- writes, without rebuilding every customer's history for each draft insert.
    IF TG_OP = 'INSERT' THEN
        IF NOT EXISTS (SELECT 1 FROM new_invoice_rows WHERE state IN ('CONFIRMED', 'PAID')) THEN
            RETURN NULL;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM old_invoice_rows WHERE state IN ('CONFIRMED', 'PAID')) THEN
            RETURN NULL;
        END IF;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM new_invoice_rows WHERE state IN ('CONFIRMED', 'PAID'))
           AND NOT EXISTS (SELECT 1 FROM old_invoice_rows WHERE state IN ('CONFIRMED', 'PAID')) THEN
            RETURN NULL;
        END IF;
    END IF;
    PERFORM refresh_finance_monthly_summary();
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS finance_monthly_summary ON invoices;
DROP TRIGGER IF EXISTS finance_monthly_summary_insert ON invoices;
DROP TRIGGER IF EXISTS finance_monthly_summary_update ON invoices;
DROP TRIGGER IF EXISTS finance_monthly_summary_delete ON invoices;
CREATE TRIGGER finance_monthly_summary_insert
AFTER INSERT ON invoices REFERENCING NEW TABLE AS new_invoice_rows
FOR EACH STATEMENT EXECUTE FUNCTION sync_finance_monthly_summary();
CREATE TRIGGER finance_monthly_summary_update
AFTER UPDATE ON invoices REFERENCING NEW TABLE AS new_invoice_rows OLD TABLE AS old_invoice_rows
FOR EACH STATEMENT EXECUTE FUNCTION sync_finance_monthly_summary();
CREATE TRIGGER finance_monthly_summary_delete
AFTER DELETE ON invoices REFERENCING OLD TABLE AS old_invoice_rows
FOR EACH STATEMENT EXECUTE FUNCTION sync_finance_monthly_summary();
SELECT refresh_finance_monthly_summary();
"""


def register_summary_cache(metadata):
    event.listen(
        metadata, "after_create", DDL(SUMMARY_DDL).execute_if(dialect="postgresql")
    )
