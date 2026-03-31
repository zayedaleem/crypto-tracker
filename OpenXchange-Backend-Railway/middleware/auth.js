// ── Auth Middleware ───────────────────────────────────────────
const { verifyJWT, getUserById, audit } = require('../services/auth');
const logger = require('../config/logger');

// Require valid JWT — redirects to login if missing/invalid
function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers?.authorization?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
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
