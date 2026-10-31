import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { db } from './utils/db.js';

export const seedInitialUsers = async () => {
  try {
    const { rows } = await db.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(rows[0]?.count || 0, 10) > 0) {
      return; // Already seeded
    }

    console.log('🌱 Seeding initial roles (Admin, Internal Staff, Customer)...');

    // 1. Admin
    const adminPw = await bcrypt.hash('Admin@12345!', 12);
    const admin2FA = speakeasy.generateSecret({ name: 'Brightloop (admin@brightloop.io)', issuer: 'Brightloop' });
    await db.query(`
      INSERT INTO users (email, password, role, full_name, company_name, two_factor_secret, two_factor_enabled)
      VALUES ('admin@brightloop.io', $1, 'ADMIN', 'Brightloop Administrator', 'Brightloop HQ', $2, 1)
    `, [adminPw, admin2FA.base32]);

    // 2. Internal Staff
    const staffPw = await bcrypt.hash('Staff@12345!', 12);
    const staff2FA = speakeasy.generateSecret({ name: 'Brightloop (staff@brightloop.io)', issuer: 'Brightloop' });
    await db.query(`
      INSERT INTO users (email, password, role, full_name, company_name, two_factor_secret, two_factor_enabled)
      VALUES ('staff@brightloop.io', $1, 'STAFF', 'Alex Morgan (Sales Rep)', 'Brightloop Operations', $2, 1)
    `, [staffPw, staff2FA.base32]);

    // 3. Customer Demo
    const custPw = await bcrypt.hash('Customer@12345!', 12);
    const cust2FA = speakeasy.generateSecret({ name: 'Brightloop (cust@company.com)', issuer: 'Brightloop' });
    await db.query(`
      INSERT INTO users (email, password, role, full_name, company_name, two_factor_secret, two_factor_enabled)
      VALUES ('cust@company.com', $1, 'CUSTOMER', 'Jane Doe', 'Acme Corporation', $2, 1)
    `, [custPw, cust2FA.base32]);

    // Seed demo subscription & invoices for Jane Doe
    const user = await db.query("SELECT id FROM users WHERE email = 'cust@company.com'");
    const custId = user.rows[0].id;

    await db.query(`
      INSERT INTO subscriptions (subscription_number, customer_id, plan_name, billing_interval, status, amount, start_date, expiry_date)
      VALUES ('SUB-89421', $1, 'Enterprise Cloud Tier', 'Monthly', 'Active', 299.00, '2026-10-01', '2027-10-01')
    `, [custId]);

    const sub = await db.query("SELECT id FROM subscriptions WHERE customer_id = $1 LIMIT 1", [custId]);
    const subId = sub.rows[0].id;

    await db.query(`
      INSERT INTO invoices (invoice_number, subscription_id, customer_id, amount, tax, total, status, due_date)
      VALUES ('INV-10928', $1, $2, 299.00, 29.90, 328.90, 'Paid', '2026-10-05')
    `, [subId, custId]);

    await db.query(`
      INSERT INTO invoices (invoice_number, subscription_id, customer_id, amount, tax, total, status, due_date)
      VALUES ('INV-11045', $1, $2, 299.00, 29.90, 328.90, 'Draft', '2026-11-05')
    `, [subId, custId]);

    console.log('✅ Seed complete with default demo accounts:');
    console.log('  Admin: admin@brightloop.io / Admin@12345!');
    console.log('  Staff: staff@brightloop.io / Staff@12345!');
    console.log('  Customer: cust@company.com / Customer@12345!');
  } catch (err) {
    console.error('Seeding error:', err);
  }
};

