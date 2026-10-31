import { Pool } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

let pool;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
} else {
  // Fallback to SQLite for development (using pg-mem or better-sqlite3 would be better)
  // For now, we'll just use individual env vars
  pool = new Pool({
    host: process.env.PGHOST,
    port: +process.env.PGPORT,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  });
}

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export { pool };