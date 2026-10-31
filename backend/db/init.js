import fs from 'fs';
import path from 'path';
import { pool } from '../utils/pg.js';

async function initializeDatabase() {
  console.log('Initializing database...');

  const schemaPath = path.join(process.cwd(), 'backend', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // Split by semicolon and execute each statement
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  for (const statement of statements) {
    try {
      await pool.query(statement);
      console.log('✓ Executed:', statement.substring(0, 50) + '...');
    } catch (err) {
      // Ignore "already exists" errors
      if (err.code === '42P07' || err.code === '23505' || err.message.includes('already exists')) {
        console.log('⊘ Skipped (already exists):', statement.substring(0, 50) + '...');
      } else {
        console.error('✗ Error:', err.message);
        console.error('Statement:', statement);
      }
    }
  }

  console.log('Database initialization complete!');
  await pool.end();
}

initializeDatabase().catch(console.error);