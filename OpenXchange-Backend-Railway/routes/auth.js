// ════════════════════════════════════════════════════════════
//  /auth — Authentication Routes
// ════════════════════════════════════════════════════════════
const router  = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const auth    = require('../services/auth');
const { requireAuth, requireSuperuser, authRateLimit } = require('../middleware/auth');
const logger  = require('../config/logger');

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   8 * 3600 * 1000,  // 8 hours
};

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// ── POST /auth/login ──────────────────────────────────────────
router.post('/login', authRateLimit,
  body('username').isString().trim().isLength({min:1,max:64}),
  body('password').isString().isLength({min:1,max:256}),
  body('totp').optional().isString().isLength({min:6,max:6}),
  validate,
  async (req, res) => {
    const { username, password, totp } = req.body;
    const ip = req.ip;

    try {
      // 1. Find user
      const user = auth.getUserByUsername(username);
      if (!user) {
        auth.audit(null, 'LOGIN_FAIL', `Unknown user: ${username}`, ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // 2. Verify password
      const pwOk = await auth.verifyPassword(password, user.password_hash);
      if (!pwOk) {
        auth.audit(user.id, 'LOGIN_FAIL', 'Wrong password', ip);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // 3. 2FA check
      if (user.totp_enabled) {
        if (!totp) {
          return res.status(200).json({ require2fa: true, userId: user.id });
        }
        const totpOk = auth.verifyTOTP(user.totp_secret, totp);
        if (!totpOk) {
          auth.audit(user.id, 'LOGIN_FAIL', '2FA invalid', ip);
          return res.status(401).json({ error: 'Invalid 2FA code' });
        }
      }

      // 4. Check if 2FA setup is required (first login)
      if (user.force_2fa_setup || !user.totp_enabled) {
        // Issue a temporary setup token
        const setupToken = auth.signJWT({ userId: user.id, purpose: 'setup2fa' });
        res.cookie('setup_token', setupToken, {...COOKIE_OPTS, maxAge: 15*60*1000});
        auth.audit(user.id, 'LOGIN_NEED_2FA_SETUP', null, ip);
        return res.json({ require2faSetup: true });
      }

      // 5. Issue full session
      const sessionId = auth.createSession(user.id, ip, req.headers['user-agent']);
      const token     = auth.signJWT({ userId: user.id, sessionId, role: user.role });
      auth.updateLastLogin(user.id);
      auth.audit(user.id, 'LOGIN_SUCCESS', null, ip);

      res.cookie('token', token, COOKIE_OPTS);
      res.json({
        success: true,
        user: {
          id:       user.id,
          username: user.username,
          role:     user.role,
          fullName: user.full_name,
        },
      });
    } catch(err) {
      logger.error('Login error: ' + err.message);
      res.status(500).json({ error: 'Login failed — try again' });
    }
  }
);

// ── POST /auth/logout ─────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  auth.invalidateSession(req.sessionId);
  auth.audit(req.user.id, 'LOGOUT', null, req.ip);
  res.clearCookie('token');
  res.clearCookie('setup_token');
  res.json({ success: true });
});

// ── GET /auth/me — current user info ─────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id, username: u.username, role: u.role,
    fullName: u.full_name, email: u.email,
    totpEnabled: !!u.totp_enabled,
  });
});

// ── GET /auth/setup-2fa — generate QR code ───────────────────
router.get('/setup-2fa', async (req, res) => {
  // Accept either full auth token OR setup_token
  const token     = req.cookies?.token || req.cookies?.setup_token;
  const payload   = auth.verifyJWT(token);
  if (!payload?.userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = auth.getUserById(payload.userId);
  if (!user)  return res.status(401).json({ error: 'User not found' });

  try {
    const secret = auth.generateTOTPSecret(user.username);
    // Store temp secret in cookie (not DB yet — user must verify first)
    const tempToken = auth.signJWT({ userId: user.id, tempSecret: secret.base32, purpose: 'verify2fa' });
    res.cookie('setup_token', tempToken, {...COOKIE_OPTS, maxAge: 15*60*1000});

    const qrDataUrl = await auth.generateQRCode(secret.otpauth_url);
    res.json({ qrCode: qrDataUrl, secret: secret.base32 });
  } catch(err) {
    logger.error('2FA setup error: ' + err.message);
    res.status(500).json({ error: 'Failed to generate 2FA code' });
  }
});

// ── POST /auth/verify-2fa — confirm new authenticator works ──
router.post('/verify-2fa',
  body('token').isString().isLength({min:6,max:6}),
  validate,
  async (req, res) => {
    const setupToken = req.cookies?.setup_token;
    const payload    = auth.verifyJWT(setupToken);
    if (!payload?.userId || payload.purpose !== 'verify2fa') {
      return res.status(401).json({ error: 'Setup session expired — please restart' });
    }

    const { token } = req.body;
    const valid = auth.verifyTOTP(payload.tempSecret, token);
    if (!valid) return res.status(400).json({ error: 'Code incorrect — try again' });

    // Save the secret permanently
    auth.saveTOTPSecret(payload.userId, payload.tempSecret);
    auth.audit(payload.userId, '2FA_ENABLED', null, req.ip);

    // Issue full session token
    const user      = auth.getUserById(payload.userId);
    const sessionId = auth.createSession(user.id, req.ip, req.headers['user-agent']);
    const fullToken = auth.signJWT({ userId: user.id, sessionId, role: user.role });
    auth.updateLastLogin(user.id);

    res.clearCookie('setup_token');
    res.cookie('token', fullToken, COOKIE_OPTS);
    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role },
    });
  }
);

// ── POST /auth/reset-request — send reset email ───────────────
router.post('/reset-request', authRateLimit,
  body('email').isEmail(),
  validate,
  async (req, res) => {
    const { email } = req.body;
    try {
      // Find user by email (don't reveal if found or not)
      const { getDb } = require('../config/database');
      const user = getDb().prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email);
      
      if (user) {
        const token   = await auth.generateResetToken(user.id);
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        await auth.sendPasswordResetEmail(email, user.username, token, baseUrl);
        auth.audit(user.id, 'RESET_REQUEST', 'Email sent', req.ip);
      }
      // Always return success (don't reveal if email exists)
      res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
    } catch(err) {
      logger.error('Reset request error: ' + err.message);
      res.status(500).json({ error: 'Failed to send reset email' });
    }
  }
);

// ── POST /auth/reset-password — set new password ─────────────
router.post('/reset-password', authRateLimit,
  body('token').isString().isLength({min:32}),
  body('password').isString().isLength({min:8,max:256}),
  validate,
  async (req, res) => {
    const { token, password } = req.body;
    try {
      const user = auth.validateResetToken(token);
      if (!user) return res.status(400).json({ error: 'Reset link is invalid or expired' });

      await auth.updatePassword(user.id, password);
      auth.audit(user.id, 'PASSWORD_RESET', null, req.ip);
      res.json({ success: true });
    } catch(err) {
      logger.error('Reset password error: ' + err.message);
      res.status(500).json({ error: 'Failed to reset password' });
    }
  }
);

// ════════════════════════════════════════════════════════════
//  ADMIN ROUTES (superuser only)
// ════════════════════════════════════════════════════════════

// GET /auth/admin/users
router.get('/admin/users', requireAuth, requireSuperuser, (req, res) => {
  res.json(auth.getAllUsers());
});

// POST /auth/admin/users — create new user
router.post('/admin/users', requireAuth, requireSuperuser,
  body('username').isString().trim().isLength({min:3,max:64}),
  body('password').isString().isLength({min:8,max:256}),
  body('role').isIn(['user','superuser']),
  body('email').optional().isEmail(),
  body('fullName').optional().isString().isLength({max:128}),
  validate,
  async (req, res) => {
    const { username, password, role, email, fullName } = req.body;
    try {
      // Check username not taken
      if (auth.getUserByUsername(username)) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      const user = await auth.createUser({ username, password, role, email, fullName, force2fa: true });
      auth.audit(req.user.id, 'ADMIN_CREATE_USER', `Created ${username} (${role})`, req.ip);

      // Send welcome email if email provided
      if (email) {
        try {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          await auth.sendAdminResetEmail(email, username, password, baseUrl);
        } catch(e) { logger.warn('Welcome email failed: ' + e.message); }
      }
      res.status(201).json(user);
    } catch(err) {
      logger.error('Create user error: ' + err.message);
      res.status(500).json({ error: 'Failed to create user' });
    }
  }
);

// DELETE /auth/admin/users/:id — deactivate user (soft delete, reversible)
router.delete('/admin/users/:id', requireAuth, requireSuperuser, (req, res) => {
  try {
    const user = auth.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.user.id === user.id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }
    auth.deactivateUser(req.params.id);
    auth.audit(req.user.id, 'ADMIN_DEACTIVATE_USER', user.username, req.ip);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/admin/users/:id/reactivate — reactivate a deactivated user
router.post('/admin/users/:id/reactivate', requireAuth, requireSuperuser, (req, res) => {
  try {
    const user = auth.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    auth.reactivateUser(req.params.id);
    auth.audit(req.user.id, 'ADMIN_REACTIVATE_USER', user.username, req.ip);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /auth/admin/users/:id/purge — permanently delete user and all their data
router.delete('/admin/users/:id/purge', requireAuth, requireSuperuser, (req, res) => {
  try {
    const user = auth.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.user.id === user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    auth.purgeUser(req.params.id);
    auth.audit(req.user.id, 'ADMIN_PURGE_USER', user.username, req.ip);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /auth/admin/users/:id/reset-password — admin resets a user's password
router.post('/admin/users/:id/reset-password', requireAuth, requireSuperuser,
  body('password').isString().isLength({min:8}),
  validate,
  async (req, res) => {
    try {
      const user = auth.getUserById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      await auth.updatePassword(req.params.id, req.body.password);
      auth.audit(req.user.id, 'ADMIN_RESET_PASSWORD', user.username, req.ip);

      // Send email if user has one
      if (user.email) {
        try {
          const baseUrl = `${req.protocol}://${req.get('host')}`;
          await auth.sendAdminResetEmail(user.email, user.username, req.body.password, baseUrl);
        } catch(e) { logger.warn('Reset email failed: ' + e.message); }
      }
      res.json({ success: true });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /auth/admin/users/:id/reset-2fa — force user to re-enroll 2FA
router.post('/admin/users/:id/reset-2fa', requireAuth, requireSuperuser, (req, res) => {
  try {
    const user = auth.getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    auth.disableTOTP(req.params.id);
    auth.audit(req.user.id, 'ADMIN_RESET_2FA', user.username, req.ip);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /auth/admin/users/:id/wallets — superuser views user's wallets
router.get('/admin/users/:id/wallets', requireAuth, requireSuperuser, (req, res) => {
  try {
    const { getDb } = require('../config/database');
    const wallets = getDb().prepare('SELECT * FROM wallets WHERE user_id=? ORDER BY date_added DESC').all(req.params.id);
    res.json(wallets);
  } catch(err) {
    // If no user_id column yet, return empty
    res.json([]);
  }
});

// GET /auth/admin/audit — view audit log
router.get('/admin/audit', requireAuth, requireSuperuser, (req, res) => {
  const { getDb } = require('../config/database');
  const logs = getDb().prepare(`
    SELECT a.*, u.username FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.timestamp DESC LIMIT 200
  `).all();
  res.json(logs);
});

module.exports = router;
