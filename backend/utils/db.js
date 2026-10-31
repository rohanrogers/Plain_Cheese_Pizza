import { Pool } from 'pg';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

let usePg = false;
let pgPool = null;
let sqliteDb = null;

// Initialize SQLite
const dbDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const sqlitePath = path.join(dbDir, 'brightloop.db');
sqliteDb = new Database(sqlitePath);
sqliteDb.pragma('foreign_keys = ON');

// Initialize schema in SQLite
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'CUSTOMER', -- 'ADMIN', 'STAFF', 'CUSTOMER'
    full_name TEXT,
    company_name TEXT,
    two_factor_secret TEXT,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    current_session_id TEXT, -- For single-device / concurrent session enforcement
    reset_token TEXT,
    reset_token_expires DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    user_id INTEGER,
    expire DATETIME NOT NULL
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT,
    ip_address TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  -- Initial mock data for Brightloop Customer Portal demonstration
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_number TEXT UNIQUE NOT NULL,
    customer_id INTEGER NOT NULL,
    plan_name TEXT NOT NULL,
    billing_interval TEXT NOT NULL, -- 'Monthly', 'Yearly'
    status TEXT NOT NULL DEFAULT 'Active', -- 'Draft', 'Quotation', 'Confirmed', 'Active', 'Closed'
    amount REAL NOT NULL,
    start_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(customer_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT UNIQUE NOT NULL,
    subscription_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'Draft', -- 'Draft', 'Confirmed', 'Paid'
    due_date DATE NOT NULL,
    paid_date DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(subscription_id) REFERENCES subscriptions(id),
    FOREIGN KEY(customer_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    method TEXT NOT NULL, -- 'Credit Card', 'Bank Transfer', 'UPI', 'PayPal'
    amount REAL NOT NULL,
    payment_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note TEXT,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id),
    FOREIGN KEY(customer_id) REFERENCES users(id)
  );
`);

console.log('✅ SQLite database initialized at:', sqlitePath);

// Unified Query Interface (Supports parameterized queries with $1, $2 OR ?, ?)
export const db = {
  isPg: () => usePg,
  
  query: async (text, params = []) => {
    if (usePg && pgPool) {
      return await pgPool.query(text, params);
    }

    // Convert PostgreSQL $1, $2 syntax to SQLite ?
    let sqliteQuery = text.replace(/\$(\d+)/g, '?');
    const trimmed = sqliteQuery.trim().toLowerCase();

    try {
      if (trimmed.startsWith('select') || trimmed.startsWith('pragma') || trimmed.startsWith('with')) {
        const stmt = sqliteDb.prepare(sqliteQuery);
        const rows = stmt.all(...params);
        return { rows, rowCount: rows.length };
      } else {
        const stmt = sqliteDb.prepare(sqliteQuery);
        const info = stmt.run(...params);
        return {
          rows: [],
          rowCount: info.changes,
          lastInsertRowid: info.lastInsertRowid
        };
      }
    } catch (err) {
      console.error('Database query error:', err.message, 'Query:', sqliteQuery);
      throw err;
    }
  },

  getSqliteInstance: () => sqliteDb
};
