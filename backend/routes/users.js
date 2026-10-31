import express from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { db } from '../utils/db.js';
import { requireAuth, requireRoles } from '../middleware/auth.js';

const router = express.Router();

/**
 * =================================================================
 * 1. ADMIN PORTAL ENDPOINTS (Strictly ADMIN role)
 * =================================================================
 */

// Get list of all staff and users for Admin dashboard
router.get('/admin/users', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, role, full_name, company_name, two_factor_enabled, created_at FROM users ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('Fetch users error:', err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

// Admin-only: Provision new Internal Staff member
router.post('/admin/provision-staff', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Password validation
    if (password.length <= 8) {
      return res.status(400).json({ error: 'Password must be more than 8 characters.' });
    }
    if (password.toLowerCase().includes(cleanEmail)) {
      return res.status(400).json({ error: 'Password cannot contain the email address.' });
    }

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const secret = speakeasy.generateSecret({
      name: `Brightloop Staff (${cleanEmail})`,
      issuer: 'Brightloop'
    });

    await db.query(
      `INSERT INTO users (email, password, role, full_name, two_factor_secret, two_factor_enabled)
       VALUES ($1, $2, 'STAFF', $3, $4, 0)`,
      [cleanEmail, hashedPassword, full_name, secret.base32]
    );

    res.status(201).json({ message: `Internal Staff member '${full_name}' provisioned successfully.` });
  } catch (err) {
    console.error('Provision staff error:', err);
    res.status(500).json({ error: 'Failed to provision staff member.' });
  }
});

// Admin-only: View system-wide financial statistics
router.get('/admin/financials', requireAuth, requireRoles('ADMIN'), async (req, res) => {
  try {
    const totalSubs = await db.query(`SELECT COUNT(*) as count, SUM(amount) as total_mrr FROM subscriptions WHERE status = 'Active'`);
    const totalInvoices = await db.query(`SELECT COUNT(*) as count, SUM(total) as total_billed FROM invoices`);
    const paidInvoices = await db.query(`SELECT COUNT(*) as count, SUM(total) as total_collected FROM invoices WHERE status = 'Paid'`);

    res.json({
      activeSubscriptions: totalSubs.rows[0]?.count || 0,
      totalMRR: totalSubs.rows[0]?.total_mrr || 0,
      totalInvoiced: totalInvoices.rows[0]?.total_billed || 0,
      totalCollected: paidInvoices.rows[0]?.total_collected || 0
    });
  } catch (err) {
    console.error('Financials error:', err);
    res.status(500).json({ error: 'Failed to retrieve financials.' });
  }
});

/**
 * =================================================================
 * 2. INTERNAL STAFF PORTAL ENDPOINTS (ADMIN & STAFF)
 * =================================================================
 */

// Staff: View customer pipelines, manage quotes, and log payments
router.get('/staff/pipeline', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const subs = await db.query(`
      SELECT s.*, u.email as customer_email, u.full_name as customer_name
      FROM subscriptions s
      JOIN users u ON s.customer_id = u.id
      ORDER BY s.created_at DESC
    `);

    const invoices = await db.query(`
      SELECT i.*, u.email as customer_email, u.full_name as customer_name
      FROM invoices i
      JOIN users u ON i.customer_id = u.id
      ORDER BY i.created_at DESC
    `);

    res.json({
      subscriptions: subs.rows,
      invoices: invoices.rows
    });
  } catch (err) {
    console.error('Staff pipeline error:', err);
    res.status(500).json({ error: 'Failed to load pipeline data.' });
  }
});

// Staff: Log a payment for an invoice
router.post('/staff/record-payment', requireAuth, requireRoles('ADMIN', 'STAFF'), async (req, res) => {
  try {
    const { invoice_id, amount, method, note } = req.body;
    if (!invoice_id || !amount || !method) {
      return res.status(400).json({ error: 'Invoice ID, amount, and payment method are required.' });
    }

    const inv = await db.query('SELECT * FROM invoices WHERE id = $1', [invoice_id]);
    if (inv.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    const invoice = inv.rows[0];

    // Record payment
    await db.query(
      `INSERT INTO payments (invoice_id, customer_id, method, amount, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [invoice_id, invoice.customer_id, method, amount, note || '']
    );

    // Update invoice status to Paid
    await db.query(`UPDATE invoices SET status = 'Paid', paid_date = CURRENT_TIMESTAMP WHERE id = $1`, [invoice_id]);

    res.json({ message: 'Payment recorded and invoice marked as Paid.' });
  } catch (err) {
    console.error('Record payment error:', err);
    res.status(500).json({ error: 'Failed to record payment.' });
  }
});

/**
 * =================================================================
 * 3. CUSTOMER PORTAL ENDPOINTS (IDOR / BOLA Protected)
 * =================================================================
 * Protected so customers can only access their OWN data.
 * Even if an attacker tries to guess/pass an ID, we query by req.currentUser.id!
 */

router.get('/customer/my-portal', requireAuth, async (req, res) => {
  try {
    const customerId = req.currentUser.id;

    // Direct binding to authenticated session user ID to eliminate IDOR/BOLA
    const subs = await db.query(
      `SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId]
    );

    const invoices = await db.query(
      `SELECT * FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId]
    );

    const payments = await db.query(
      `SELECT * FROM payments WHERE customer_id = $1 ORDER BY payment_date DESC`,
      [customerId]
    );

    res.json({
      customer: {
        id: req.currentUser.id,
        email: req.currentUser.email,
        full_name: req.currentUser.full_name,
        company_name: req.currentUser.company_name
      },
      subscriptions: subs.rows,
      invoices: invoices.rows,
      payments: payments.rows
    });
  } catch (err) {
    console.error('Customer portal error:', err);
    res.status(500).json({ error: 'Failed to fetch customer portal data.' });
  }
});

export default router;
