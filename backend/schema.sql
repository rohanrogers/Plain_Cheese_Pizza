-- Bootstrap DDL, not an existing-schema upgrade migration. See backend/app/migrations.py.


CREATE TABLE auth_throttles (
	key VARCHAR(64) NOT NULL,
	count INTEGER NOT NULL,
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (key)
)

;


CREATE TABLE mail_outbox (
	id VARCHAR(36) NOT NULL,
	recipient VARCHAR(254) NOT NULL,
	subject VARCHAR(200) NOT NULL,
	body TEXT NOT NULL,
	status VARCHAR(30) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id)
)

;


CREATE TABLE plans (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	price BIGINT NOT NULL,
	interval VARCHAR(20) NOT NULL,
	interval_count INTEGER NOT NULL,
	min_quantity INTEGER NOT NULL,
	available_from DATE,
	available_until DATE,
	auto_close BOOLEAN NOT NULL,
	allow_close BOOLEAN NOT NULL,
	allow_pause BOOLEAN NOT NULL,
	allow_renew BOOLEAN NOT NULL,
	PRIMARY KEY (id)
)

;


CREATE TABLE schema_migrations (
	revision VARCHAR(100) NOT NULL,
	applied_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (revision)
)

;


CREATE TABLE taxes (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	rate_bps INTEGER NOT NULL,
	PRIMARY KEY (id)
)

;


CREATE TABLE users (
	id VARCHAR(36) NOT NULL,
	email VARCHAR(254) NOT NULL,
	name VARCHAR(120) NOT NULL,
	password_hash TEXT NOT NULL,
	role VARCHAR(20) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (email)
)

;


CREATE TABLE audit_events (
	id VARCHAR(36) NOT NULL,
	actor_id VARCHAR(36) NOT NULL,
	entity_id VARCHAR(36) NOT NULL,
	action VARCHAR(120) NOT NULL,
	detail TEXT NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(actor_id) REFERENCES users (id)
)

;


CREATE TABLE auth_sessions (
	token_hash VARCHAR(64) NOT NULL,
	user_id VARCHAR(36) NOT NULL,
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (token_hash),
	FOREIGN KEY(user_id) REFERENCES users (id)
)

;


CREATE TABLE customer_payment_methods (
	id VARCHAR(36) NOT NULL,
	customer_id VARCHAR(36) NOT NULL,
	kind VARCHAR(20) NOT NULL,
	label VARCHAR(120) NOT NULL,
	last_four VARCHAR(4) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(customer_id) REFERENCES users (id)
)

;


CREATE TABLE invoice_monthly_summaries (
	customer_id VARCHAR(36) NOT NULL,
	month_start DATE NOT NULL,
	net BIGINT NOT NULL,
	invoice_count BIGINT NOT NULL,
	PRIMARY KEY (customer_id, month_start),
	FOREIGN KEY(customer_id) REFERENCES users (id)
)

;


CREATE TABLE login_challenges (
	token_hash VARCHAR(64) NOT NULL,
	user_id VARCHAR(36) NOT NULL,
	password_fingerprint VARCHAR(64) NOT NULL,
	method VARCHAR(10) NOT NULL,
	code_hash VARCHAR(64),
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	attempts INTEGER NOT NULL,
	PRIMARY KEY (token_hash),
	FOREIGN KEY(user_id) REFERENCES users (id)
)

;


CREATE TABLE password_resets (
	token_hash VARCHAR(64) NOT NULL,
	user_id VARCHAR(36) NOT NULL,
	expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	used BOOLEAN NOT NULL,
	PRIMARY KEY (token_hash),
	FOREIGN KEY(user_id) REFERENCES users (id)
)

;


CREATE TABLE products (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	kind VARCHAR(30) NOT NULL,
	price BIGINT NOT NULL,
	cost BIGINT NOT NULL,
	notes TEXT NOT NULL,
	tax_id VARCHAR(36),
	active BOOLEAN NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(tax_id) REFERENCES taxes (id)
)

;


CREATE TABLE quote_templates (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	plan_id VARCHAR(36) NOT NULL,
	validity_days INTEGER NOT NULL,
	lines JSON NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(plan_id) REFERENCES plans (id)
)

;


CREATE TABLE second_factors (
	user_id VARCHAR(36) NOT NULL,
	secret_encrypted TEXT,
	enabled BOOLEAN NOT NULL,
	last_counter BIGINT NOT NULL,
	pending_encrypted TEXT,
	pending_expires_at TIMESTAMP WITHOUT TIME ZONE,
	PRIMARY KEY (user_id),
	FOREIGN KEY(user_id) REFERENCES users (id)
)

;


CREATE TABLE discounts (
	id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	kind VARCHAR(20) NOT NULL,
	value BIGINT NOT NULL,
	min_amount BIGINT NOT NULL,
	min_quantity INTEGER NOT NULL,
	starts_on DATE NOT NULL,
	ends_on DATE NOT NULL,
	max_uses INTEGER NOT NULL,
	uses INTEGER NOT NULL,
	product_id VARCHAR(36),
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
)

;


CREATE TABLE variants (
	id VARCHAR(36) NOT NULL,
	product_id VARCHAR(36) NOT NULL,
	name VARCHAR(120) NOT NULL,
	modifier BIGINT NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
)

;


CREATE TABLE subscriptions (
	id VARCHAR(36) NOT NULL,
	number VARCHAR(30) NOT NULL,
	customer_id VARCHAR(36) NOT NULL,
	plan_id VARCHAR(36) NOT NULL,
	discount_id VARCHAR(36),
	state VARCHAR(20) NOT NULL,
	starts_on DATE NOT NULL,
	expires_on DATE,
	quote_expires_on DATE NOT NULL,
	payment_days INTEGER NOT NULL,
	next_billing_date DATE NOT NULL,
	anchor_date DATE NOT NULL,
	cycle_index INTEGER NOT NULL,
	interval VARCHAR(20) NOT NULL,
	interval_count INTEGER NOT NULL,
	lines JSON NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (number),
	FOREIGN KEY(customer_id) REFERENCES users (id),
	FOREIGN KEY(plan_id) REFERENCES plans (id),
	FOREIGN KEY(discount_id) REFERENCES discounts (id)
)

;


CREATE TABLE invoices (
	id VARCHAR(36) NOT NULL,
	number VARCHAR(30) NOT NULL,
	subscription_id VARCHAR(36) NOT NULL,
	customer_id VARCHAR(36) NOT NULL,
	period_start DATE NOT NULL,
	due_date DATE NOT NULL,
	state VARCHAR(20) NOT NULL,
	lines JSON NOT NULL,
	subtotal BIGINT NOT NULL,
	discount BIGINT NOT NULL,
	tax BIGINT NOT NULL,
	total BIGINT NOT NULL,
	paid BIGINT NOT NULL,
	discount_reason TEXT NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_billing_period UNIQUE (subscription_id, period_start),
	CONSTRAINT ck_invoice_amounts CHECK (subtotal >= 0 AND discount >= 0 AND discount <= subtotal AND tax >= 0),
	CONSTRAINT ck_invoice_balance CHECK (total = subtotal - discount + tax AND paid >= 0 AND paid <= total),
	CONSTRAINT ck_invoice_state CHECK (state IN ('DRAFT','CONFIRMED','PAID','CANCELLED')),
	UNIQUE (number),
	FOREIGN KEY(subscription_id) REFERENCES subscriptions (id),
	FOREIGN KEY(customer_id) REFERENCES users (id)
)

;


CREATE TABLE payments (
	id VARCHAR(36) NOT NULL,
	invoice_id VARCHAR(36) NOT NULL,
	amount BIGINT NOT NULL,
	method VARCHAR(30) NOT NULL,
	paid_on DATE NOT NULL,
	note TEXT NOT NULL,
	reference VARCHAR(120) NOT NULL,
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_payment_positive CHECK (amount > 0),
	FOREIGN KEY(invoice_id) REFERENCES invoices (id),
	UNIQUE (reference)
)

;

CREATE INDEX ix_audit_events_entity_id ON audit_events (entity_id);
CREATE INDEX ix_customer_payment_methods_customer_id ON customer_payment_methods (customer_id);
CREATE INDEX ix_login_challenges_user_id ON login_challenges (user_id);
CREATE INDEX ix_subs_due ON subscriptions (state, next_billing_date);
CREATE INDEX ix_subscriptions_customer_id ON subscriptions (customer_id);
CREATE INDEX ix_invoice_aging ON invoices (state, due_date);
CREATE INDEX ix_invoice_period ON invoices (period_start, state);
CREATE INDEX ix_invoices_customer_id ON invoices (customer_id);
CREATE INDEX ix_payment_date ON payments (paid_on);
CREATE INDEX ix_payments_invoice_id ON payments (invoice_id);


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
