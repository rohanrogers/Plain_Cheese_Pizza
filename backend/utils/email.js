import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

// Create transporter - if smtp is dummy, log email to console for development
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_USER !== 'xxxxx') {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export const sendMail = async ({ to, subject, html, text }) => {
  console.log(`\n================= [SIMULATED EMAIL DISPATCH] =================`);
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  if (text) console.log(`Body:\n${text}`);
  if (html) console.log(`HTML Preview:\n${html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim()}`);
  console.log(`===============================================================\n`);

  if (transporter) {
    try {
      await transporter.sendMail({
        from: '"Brightloop Security" <security@brightloop.io>',
        to,
        subject,
        html: html || `<p>${text}</p>`,
        text: text || ''
      });
    } catch (e) {
      console.warn('SMTP transport dispatch notice (using console fallback):', e.message);
    }
  }

  return { success: true };
};
