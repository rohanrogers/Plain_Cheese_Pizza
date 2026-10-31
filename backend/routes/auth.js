import express from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
import crypto from 'crypto';
import { db } from '../utils/db.js';
import { sendMail } from '../utils/email.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Password Policy Enforcement:
 * 1. More than 8 characters (> 8)
 * 2. At least 1 uppercase letter
 * 3. At least 1 lowercase letter
 * 4. At least 1 special character
 * 5. Password CANNOT match or contain the email address
 */
const validatePasswordPolicy = (password, email) => {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required.' };
  }

  if (email && typeof email === 'string') {
    const cleanEmail = email.toLowerCase().trim();
    const cleanPassword = password.toLowerCase();

    // Check if password matches or contains whole email
    if (cleanPassword === cleanEmail || cleanPassword.includes(cleanEmail)) {
      return { valid: false, message: 'Password cannot be your email address or contain your full email.' };
    }

    // Check if password is equal to the username portion before the '@'
    const emailPrefix = cleanEmail.split('@')[0];
    if (emailPrefix.length >= 3 && cleanPassword.includes(emailPrefix)) {
      return { valid: false, message: 'Password cannot contain your email username prefix.' };
    }
  }

  if (password.length <= 8) {
    return { valid: false, message: 'Password must be more than 8 characters.' };
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password);

  if (!hasUpper || !hasLower || !hasSpecial) {
    return {
      valid: false,
      message: 'Password must contain at least one uppercase letter, one lowercase letter, and one special character.'
    };
  }

  return { valid: true };
};

// ==========================================
// 1. REGISTER / SIGN UP (Customer Self-Service)
// ==========================================
router.post('/signup', async (req, res) => {
  try {
    const { email, password, full_name, company_name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Password policy validation
    const pwCheck = validatePasswordPolicy(password, cleanEmail);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.message });
    }

    // Check unique email
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create 2FA secret
    const secret = speakeasy.generateSecret({
      name: `Brightloop (${cleanEmail})`,
      issuer: 'Brightloop'
    });

    const insertResult = await db.query(
      `INSERT INTO users (email, password, role, full_name, company_name, two_factor_secret, two_factor_enabled)
       VALUES ($1, $2, 'CUSTOMER', $3, $4, $5, 0)`,
      [cleanEmail, hashedPassword, full_name || '', company_name || '', secret.base32]
    );

    // Provide initial demo subscription for this customer
    const userRes = await db.query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    const newUserId = userRes.rows[0].id;

    await db.query(`
      INSERT INTO subscriptions (subscription_number, customer_id, plan_name, billing_interval, status, amount, start_date, expiry_date)
      VALUES ($1, $2, 'Standard Business Plan', 'Monthly', 'Active', 120.00, '2026-10-01', '2027-10-01')
    `, [`SUB-${Math.floor(100000 + Math.random() * 900000)}`, newUserId]);

    const subRes = await db.query('SELECT id FROM subscriptions WHERE customer_id = $1 LIMIT 1', [newUserId]);
    const subId = subRes.rows[0].id;

    await db.query(`
      INSERT INTO invoices (invoice_number, subscription_id, customer_id, amount, tax, total, status, due_date)
      VALUES ($1, $2, $3, 120.00, 12.00, 132.00, 'Paid', '2026-10-15')
    `, [`INV-${Math.floor(100000 + Math.random() * 900000)}`, subId, newUserId]);

    res.status(201).json({
      message: 'Account created successfully. Please login to complete 2FA verification.',
      email: cleanEmail
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Internal server error while creating account.' });
  }
});

// ==========================================
// 2. LOGIN (Step 1: Credentials -> Check 2FA)
// ==========================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const { rows } = await db.query(
      'SELECT id, email, password, role, full_name, company_name, two_factor_secret, two_factor_enabled FROM users WHERE email = $1',
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Save temporary verification state in session
    req.session.pendingUserId = user.id;

    // Check if 2FA secret is set up
    let secretBase32 = user.two_factor_secret;
    if (!secretBase32) {
      const generated = speakeasy.generateSecret({
        name: `Brightloop (${user.email})`,
        issuer: 'Brightloop'
      });
      secretBase32 = generated.base32;
      await db.query('UPDATE users SET two_factor_secret = $1 WHERE id = $2', [secretBase32, user.id]);
    }

    // Always require 2FA
    // Generate QR code for convenient authenticator setup or verification
    const otpauthUrl = speakeasy.otpauthURL({
      secret: secretBase32,
      label: `Brightloop (${user.email})`,
      issuer: 'Brightloop',
      encoding: 'base32'
    });
    const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl);

    // Also generate an immediate 6-digit email OTP fallback
    const emailOtp = speakeasy.totp({
      secret: secretBase32,
      encoding: 'base32'
    });

    await sendMail({
      to: user.email,
      subject: 'Your Brightloop Security 2FA Code',
      text: `Hello ${user.full_name || 'User'},\n\nYour 2-Factor Authentication OTP code is: ${emailOtp}\nThis code is valid for 60 seconds.`,
      html: `<h3>Brightloop 2-Factor Authentication</h3><p>Your one-time passcode (OTP) is: <b><span style="font-size:24px; letter-spacing:4px; color:#2563eb;">${emailOtp}</span></b></p><p>You can also scan the QR code in your Authenticator app (Google Authenticator, Authy, etc.).</p>`
    });

    return res.status(200).json({
      require2FA: true,
      message: 'Password verified. 2FA Code required to complete login.',
      email: user.email,
      qrCode: qrCodeDataUrl,
      twoFactorEnabled: Boolean(user.two_factor_enabled)
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// ==========================================
// 3. 2FA VERIFICATION (Step 2: Authenticator / OTP)
// ==========================================
router.post('/verify-2fa', async (req, res) => {
  try {
    const { token } = req.body;
    const userId = req.session.pendingUserId;

    if (!userId) {
      return res.status(401).json({ error: 'Session expired. Please initiate login again.' });
    }

    if (!token || token.trim().length !== 6) {
      return res.status(400).json({ error: 'Please enter a valid 6-digit OTP code.' });
    }

    const { rows } = await db.query(
      'SELECT id, email, role, full_name, company_name, two_factor_secret FROM users WHERE id = $1',
      [userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const user = rows[0];

    const verified = speakeasy.totp.verify({
      secret: user.two_factor_secret,
      encoding: 'base32',
      token: token.trim(),
      window: 2 // Allow a 60-second clock-drift window
    });

    if (!verified) {
      return res.status(400).json({ error: 'Invalid or expired 2FA code. Please check your authenticator or email.' });
    }

    // Mark 2FA verified
    await db.query('UPDATE users SET two_factor_enabled = 1 WHERE id = $1', [user.id]);

    // Single-device policy: Destroy any existing sessions for this user in DB
    const newSessionId = req.sessionID;
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND sid != $2', [user.id, newSessionId]);
    await db.query('UPDATE users SET current_session_id = $1 WHERE id = $2', [newSessionId, user.id]);

    // Commit authenticated user info to session
    req.session.pendingUserId = null;
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      full_name: user.full_name,
      company_name: user.company_name
    };

    // Save session explicitly
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Failed to establish session.' });
      }

      res.status(200).json({
        message: '2FA authentication successful.',
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          full_name: user.full_name,
          company_name: user.company_name
        }
      });
    });
  } catch (err) {
    console.error('2FA error:', err);
    res.status(500).json({ error: 'Internal server error verifying 2FA.' });
  }
});

// ==========================================
// 4. CHECK CURRENT SESSION / AUTH STATE
// ==========================================
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.currentUser.id,
      email: req.currentUser.email,
      role: req.currentUser.role,
      full_name: req.currentUser.full_name
    }
  });
});

// ==========================================
// 5. LOGOUT
// ==========================================
router.post('/logout', requireAuth, async (req, res) => {
  try {
    const userId = req.currentUser.id;
    await db.query('UPDATE users SET current_session_id = NULL WHERE id = $1', [userId]);
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: 'Logout failed.' });
      }
      res.clearCookie('connect.sid');
      res.json({ message: 'Logged out successfully.' });
    });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

// ==========================================
// 6. PASSWORD RESET WORKFLOW (Forgot Password)
// ==========================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const { rows } = await db.query('SELECT id, email, full_name FROM users WHERE email = $1', [cleanEmail]);

    // For security, do not disclose whether user exists or not, but dispatch if found
    if (rows.length > 0) {
      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpires = new Date(Date.now() + 1000 * 60 * 30).toISOString(); // 30 minutes

      await db.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [resetToken, resetExpires, user.id]
      );

      const resetLink = `http://localhost:3000/reset-password?token=${resetToken}&email=${encodeURIComponent(cleanEmail)}`;

      await sendMail({
        to: user.email,
        subject: 'Reset Your Brightloop Password',
        text: `Hello ${user.full_name || 'Customer'},\n\nWe received a request to reset your password.\nPlease click the link below or copy and paste it into your browser to reset your password:\n${resetLink}\n\nThis link is valid for 30 minutes. If you did not make this request, you can safely ignore this email.`,
        html: `<h3>Password Reset Request</h3>
               <p>We received a request to reset your password for your Brightloop account.</p>
               <p><a href="${resetLink}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold;">Reset Password</a></p>
               <p>Or copy this link: <br><code>${resetLink}</code></p>
               <p><small>Link expires in 30 minutes.</small></p>`
      });
    }

    res.json({
      message: 'If an account with that email exists, password reset instructions have been sent.'
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Internal server error sending password reset link.' });
  }
});

// ==========================================
// 7. CONFIRM PASSWORD RESET (New Password with Policy)
// ==========================================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) {
      return res.status(400).json({ error: 'Token, email, and new password are required.' });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check password policy
    const pwCheck = validatePasswordPolicy(newPassword, cleanEmail);
    if (!pwCheck.valid) {
      return res.status(400).json({ error: pwCheck.message });
    }

    const { rows } = await db.query(
      'SELECT id, reset_token, reset_token_expires FROM users WHERE email = $1',
      [cleanEmail]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token.' });
    }

    const user = rows[0];

    if (!user.reset_token || user.reset_token !== token) {
      return res.status(400).json({ error: 'Invalid reset token.' });
    }

    if (new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password, clear reset token, and invalidate all existing sessions
    await db.query(
      'UPDATE users SET password = $1, reset_token = NULL, reset_token_expires = NULL, current_session_id = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );

    await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);

    res.json({ message: 'Password has been successfully reset. You may now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Internal server error resetting password.' });
  }
});

export default router;
