// ════════════════════════════════════════════════════════════
//  OpenXchange Auth Service
//  Handles: bcrypt passwords, TOTP 2FA, JWT sessions,
//           password reset emails via Outlook
// ════════════════════════════════════════════════════════════
const bcrypt     = require('bcryptjs');
const speakeasy  = require('speakeasy');
const QRCode     = require('qrcode');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb }  = require('../config/database');
const logger     = require('../config/logger');

const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES = '8h';
const APP_NAME    = 'OpenXchange';

// ── Email transporter (Outlook) ───────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    host:   'smtp-mail.outlook.com',
    port:   587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { ciphers: 'SSLv3' },
  });
}

// ── Audit log helper ──────────────────────────────────────────
function audit(userId, action, detail, ip) {
  try {
    getDb().prepare(
      'INSERT INTO audit_log (user_id,action,detail,ip_address,timestamp) VALUES (?,?,?,?,?)'
    ).run(userId||null, action, detail||null, ip||null, Date.now());
  } catch(e) { logger.warn('Audit log error: ' + e.message); }
}

// ════════════════════════════════════════════════════════════
//  USER MANAGEMENT
// ════════════════════════════════════════════════════════════

async function createUser({ username, password, role='user', email='', fullName='', force2fa=true }) {
  const hash = await bcrypt.hash(password, 12);
  const id   = uuidv4();
  getDb().prepare(`
    INSERT INTO users (id,username,password_hash,role,email,full_name,created_at,force_2fa_setup)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, username.toLowerCase(), hash, role, email||'', fullName||'', Date.now(), force2fa?1:0);
  logger.info(`User created: ${username} (${role})`);
  return { id, username, role };
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.toLowerCase());
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(id);
}

function getAllUsers() {
  return getDb().prepare(`
    SELECT id, username, role, email, full_name, created_at, last_login, 
           is_active, totp_enabled, force_2fa_setup
    FROM users ORDER BY created_at DESC
  `).all();
}

async function updatePassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 12);
  getDb().prepare('UPDATE users SET password_hash=?,reset_token=NULL,reset_token_exp=NULL WHERE id=?').run(hash, userId);
}

function deactivateUser(userId) {
  getDb().prepare('UPDATE users SET is_active=0 WHERE id=?').run(userId);
}

function reactivateUser(userId) {
  getDb().prepare('UPDATE users SET is_active=1 WHERE id=?').run(userId);
}

// Hard delete — permanently removes user account and all active sessions
function purgeUser(userId) {
  const db = getDb();
  // Invalidate all active sessions immediately
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  // Remove the user record
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  // Note: audit_log entries are intentionally kept (user_id becomes a dangling ref)
  // for compliance — the log still shows what actions were taken before deletion
}

// ════════════════════════════════════════════════════════════
//  AUTHENTICATION
// ════════════════════════════════════════════════════════════

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function verifyTOTP(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1,  // allow 30s clock drift
  });
}

function createSession(userId, ip, userAgent) {
  const sessionId = uuidv4();
  const now       = Date.now();
  const exp       = now + 8 * 3600 * 1000; // 8 hours
  getDb().prepare(`
    INSERT INTO sessions (id,user_id,created_at,expires_at,ip_address,user_agent)
    VALUES (?,?,?,?,?,?)
  `).run(sessionId, userId, now, exp, ip||'', userAgent||'');
  return sessionId;
}

function signJWT(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}

function invalidateSession(sessionId) {
  getDb().prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
}

function cleanExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

function updateLastLogin(userId) {
  getDb().prepare('UPDATE users SET last_login=? WHERE id=?').run(Date.now(), userId);
}

// ════════════════════════════════════════════════════════════
//  2FA SETUP
// ════════════════════════════════════════════════════════════

function generateTOTPSecret(username) {
  return speakeasy.generateSecret({
    name:   `${APP_NAME} (${username})`,
    issuer: APP_NAME,
    length: 20,
  });
}

async function generateQRCode(otpauth_url) {
  return QRCode.toDataURL(otpauth_url);
}

function saveTOTPSecret(userId, secret) {
  getDb().prepare('UPDATE users SET totp_secret=?,totp_enabled=1,force_2fa_setup=0 WHERE id=?').run(secret, userId);
}

function disableTOTP(userId) {
  getDb().prepare('UPDATE users SET totp_secret=NULL,totp_enabled=0,force_2fa_setup=1 WHERE id=?').run(userId);
}

// ════════════════════════════════════════════════════════════
//  PASSWORD RESET
// ════════════════════════════════════════════════════════════

async function generateResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp   = Date.now() + 60 * 60 * 1000; // 1 hour
  getDb().prepare('UPDATE users SET reset_token=?,reset_token_exp=? WHERE id=?').run(token, exp, userId);
  return token;
}

function validateResetToken(token) {
  const user = getDb().prepare(
    'SELECT * FROM users WHERE reset_token=? AND reset_token_exp>? AND is_active=1'
  ).get(token, Date.now());
  return user || null;
}

async function sendPasswordResetEmail(toEmail, username, resetToken, baseUrl) {
  const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;
  const mailer    = getMailer();

  await mailer.sendMail({
    from:    `"${APP_NAME}" <${process.env.SMTP_USER}>`,
    to:      toEmail,
    subject: `${APP_NAME} — Password Reset Request`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#060b18;color:#e0e0e0;padding:32px;border-radius:12px">
        <h2 style="color:#627eea;margin-bottom:16px">${APP_NAME} Password Reset</h2>
        <p>Hello <strong>${username}</strong>,</p>
        <p style="margin:16px 0">A password reset was requested for your account. Click the button below to set a new password.</p>
        <a href="${resetLink}" style="display:inline-block;background:#627eea;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Reset Password</a>
        <p style="font-size:12px;color:#888;margin-top:24px">This link expires in 1 hour. If you did not request a reset, ignore this email.</p>
        <p style="font-size:12px;color:#888">If the button doesn't work, copy this link:<br>${resetLink}</p>
      </div>
    `,
  });
}

async function sendAdminResetEmail(toEmail, username, tempPassword, baseUrl) {
  const mailer = getMailer();
  await mailer.sendMail({
    from:    `"${APP_NAME}" <${process.env.SMTP_USER}>`,
    to:      toEmail,
    subject: `${APP_NAME} — Your Account Credentials`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#060b18;color:#e0e0e0;padding:32px;border-radius:12px">
        <h2 style="color:#627eea;margin-bottom:16px">${APP_NAME} Account Access</h2>
        <p>Hello <strong>${username}</strong>,</p>
        <p style="margin:16px 0">Your account credentials have been set up:</p>
        <div style="background:#0d1425;padding:16px;border-radius:8px;margin:16px 0">
          <p><strong>Username:</strong> ${username}</p>
          <p><strong>Temporary Password:</strong> <code style="color:#00e5ff">${tempPassword}</code></p>
        </div>
        <p>Please log in and change your password immediately.</p>
        <p style="margin-top:16px">You will also be asked to set up 2FA (Google Authenticator) on your first login.</p>
        <a href="${baseUrl}/login.html" style="display:inline-block;background:#627eea;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0">Log In Now</a>
      </div>
    `,
  });
}

// ════════════════════════════════════════════════════════════
//  SUPERUSER SEED
// ════════════════════════════════════════════════════════════

async function seedSuperuser() {
  const existing = getUserByUsername(process.env.SUPERUSER_USERNAME || 'zayedaleem');
  if (existing) {
    logger.info('Superuser already exists');
    return;
  }
  await createUser({
    username:  process.env.SUPERUSER_USERNAME || 'zayedaleem',
    password:  process.env.SUPERUSER_PASSWORD || 'Zayed@589760242',
    role:      'superuser',
    email:     process.env.SUPERUSER_EMAIL || 'zayedaleem@gmail.com',
    fullName:  'Zayed Aleem',
    force2fa:  true,
  });
  logger.info('Superuser account created — set up 2FA on first login');
}

module.exports = {
  createUser, getUserByUsername, getUserById, getAllUsers,
  updatePassword, deactivateUser, reactivateUser, purgeUser,
  verifyPassword, verifyTOTP, createSession, signJWT, verifyJWT,
  invalidateSession, cleanExpiredSessions, updateLastLogin,
  generateTOTPSecret, generateQRCode, saveTOTPSecret, disableTOTP,
  generateResetToken, validateResetToken,
  sendPasswordResetEmail, sendAdminResetEmail,
  seedSuperuser, audit,
};
