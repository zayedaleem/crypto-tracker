// ════════════════════════════════════════════════════════════
//  OpenXchange Portfolio Tracker — Backend Server
//  Node.js / Express  |  All exchange signing done server-side
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const compression= require('compression');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const cookieParser = require('cookie-parser');
const logger     = require('./config/logger');
const db         = require('./config/database');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], frameAncestors: ["'none'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'", "fonts.googleapis.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "fonts.gstatic.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      fontSrc:    ["'self'", "fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "api.coingecko.com", "api.binance.com",
                   "api.bybit.com", "api.kucoin.com", "api.gateio.ws",
                   "www.okx.com", "moralis.io", "rpc.ankr.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(cookieParser());

// ── CORS ─────────────────────────────────────────────────────
// IMPORTANT for Vercel ↔ Railway cross-domain auth:
//   ALLOWED_ORIGINS must include your exact Vercel URL, e.g.:
//   https://crypto-tracker-olive-five.vercel.app
//   (no trailing slash, no wildcards — browsers require exact origin for credentialed requests)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:8080')
  .split(',').map(o => o.trim().replace(/\/+$/, '')); // strip trailing slashes

app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin requests (origin is undefined for server-to-server)
    if (!origin) return cb(null, true);
    // Exact match or prefix match (handles both with and without trailing slash)
    const clean = origin.replace(/\/+$/, '');
    if (allowedOrigins.some(o => clean === o || clean.startsWith(o))) {
      return cb(null, true);
    }
    logger.warn(`CORS blocked origin: ${origin}`);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,              // Required: allows cookies to be sent cross-origin
  exposedHeaders: ['Set-Cookie'], // Ensure cookie headers are visible to the browser
}));

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Request logging ───────────────────────────────────────────
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ── Global rate limiting ──────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 120,               // 120 req/min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
}));

// ── Serve frontend static files ───────────────────────────────
// Drop your tracker.html and site files into the /public folder
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────
app.use('/auth',          require('./routes/auth'));
app.use('/api/prices',    require('./routes/prices'));
app.use('/api/wallets',   require('./routes/wallets'));
app.use('/api/exchanges', require('./routes/exchanges'));
app.use('/api/nfts',      require('./routes/nfts'));
app.use('/api/keys',      require('./routes/keys'));
app.use('/api/test',      require('./routes/test'));

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── SPA fallback (serve tracker.html for all non-API routes) ──
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'tracker.html'));
  } else {
    res.status(404).json({ error: 'Endpoint not found' });
  }
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error(`${err.message} — ${req.method} ${req.path}`);
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Start server ──────────────────────────────────────────────
db.init();

// Seed superuser on startup
const authService = require('./services/auth');
authService.seedSuperuser().catch(e => require('./config/logger').error('Seed error: ' + e.message));

// Clean expired sessions every hour
setInterval(() => authService.cleanExpiredSessions(), 3600000);

app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Frontend served from: /public`);
});

module.exports = app;
