// ── Auth Middleware ───────────────────────────────────────────
const { verifyJWT, getUserById, audit } = require('../services/auth');
const logger = require('../config/logger');

// Token resolution order:
//   1. HttpOnly cookie 'token'          (same-origin or properly configured cross-origin)
//   2. Authorization: Bearer <token>    (fallback when cookies are blocked cross-domain)
//   3. X-Auth-Token header              (alternative header fallback)
function extractToken(req) {
  return req.cookies?.token
    || req.cookies?.setup_token  // for 2FA setup flow
    || req.headers?.authorization?.replace('Bearer ', '').trim()
    || req.headers?.['x-auth-token'];
}

// Require valid JWT — redirects to login if missing/invalid
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login.html');
  }

  const payload = verifyJWT(token);
  if (!payload) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
    return res.redirect('/login.html?expired=1');
  }

  const user = getUserById(payload.userId);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'User not found' });
    return res.redirect('/login.html');
  }

  req.user = user;
  req.sessionId = payload.sessionId;
  next();
}

// Require superuser role
function requireSuperuser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.role !== 'superuser') {
    audit(req.user.id, 'UNAUTHORIZED_ACCESS', req.path, req.ip);
    return res.status(403).json({ error: 'Superuser access required' });
  }
  next();
}

// Rate limiter for auth endpoints
const rateLimit = require('express-rate-limit');
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                    // 10 attempts per window
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { requireAuth, requireSuperuser, authRateLimit };
