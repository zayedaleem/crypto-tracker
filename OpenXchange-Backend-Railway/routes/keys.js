// ── /api/keys — Wallet & Exchange key management ─────────────
const router  = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { encrypt, decrypt } = require('../config/encryption');
const { getDb }  = require('../config/database');
const logger = require('../config/logger');
const crypto = require('crypto');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

function sanitize(str, maxLen = 128) {
  return String(str || '').replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

// ── WALLETS ───────────────────────────────────────────────────
// GET /api/keys/wallets
router.get('/wallets', (req, res) => {
  try {
    const wallets = getDb().prepare('SELECT * FROM wallets ORDER BY date_added DESC').all();
    // Never expose addresses to front-end in a way that leaks them in logs
    res.json(wallets.map(w => ({
      id: w.id, label: w.label, address: w.address,
      chain: w.chain, dateAdded: w.date_added, lastSynced: w.last_synced,
    })));
  } catch (err) {
    logger.error(`GET /wallets: ${err.message}`);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/keys/wallets
router.post('/wallets',
  body('label').isString().trim().isLength({ min: 1, max: 64 }),
  body('address').isString().trim().isLength({ min: 10, max: 128 }),
  body('chain').isString().isIn(['BITCOIN','ETHEREUM','BSC','POLYGON','ARBITRUM',
    'OPTIMISM','BASE','AVALANCHE','SOLANA','TRON']),
  validate,
  (req, res) => {
    try {
      const { label, address, chain } = req.body;
      const id = 'w_' + crypto.randomBytes(8).toString('hex');
      getDb().prepare(
        'INSERT INTO wallets (id,label,address,chain,date_added) VALUES (?,?,?,?,?)'
      ).run(id, sanitize(label, 64), sanitize(address, 128), chain, Date.now());
      res.status(201).json({ id, label, address, chain });
    } catch (err) {
      logger.error(`POST /wallets: ${err.message}`);
      res.status(500).json({ error: 'Failed to save wallet' });
    }
  }
);

// DELETE /api/keys/wallets/:id
router.delete('/wallets/:id', param('id').isString(), validate, (req, res) => {
  try {
    getDb().prepare('DELETE FROM wallets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete wallet' });
  }
});

// ── EXCHANGE ACCOUNTS ─────────────────────────────────────────
// GET /api/keys/accounts
router.get('/accounts', (req, res) => {
  try {
    const accounts = getDb().prepare('SELECT * FROM exchange_accounts ORDER BY date_added DESC').all();
    res.json(accounts.map(a => ({
      id: a.id, label: a.label, exchange: a.exchange,
      // Mask the API key — only show last 4 chars
      apiKeyMasked: '••••••••' + decrypt(a.api_key_enc).slice(-4),
      hasPassphrase: !!a.passphrase_enc,
      dateAdded: a.date_added, lastSynced: a.last_synced,
    })));
  } catch (err) {
    logger.error(`GET /accounts: ${err.message}`);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/keys/accounts
router.post('/accounts',
  body('label').isString().trim().isLength({ min: 1, max: 64 }),
  body('exchange').isString().isIn(['BINANCE','BYBIT','KUCOIN','GATE_IO','OKX']),
  body('apiKey').isString().trim().isLength({ min: 10, max: 256 }),
  body('apiSecret').isString().trim().isLength({ min: 10, max: 512 }),
  body('passphrase').optional({ nullable: true }).isString().isLength({ max: 128 }),
  validate,
  (req, res) => {
    try {
      const { label, exchange, apiKey, apiSecret, passphrase } = req.body;
      const id = 'ex_' + crypto.randomBytes(8).toString('hex');
      getDb().prepare(`
        INSERT OR REPLACE INTO exchange_accounts (id,label,exchange,api_key_enc,api_sec_enc,passphrase_enc,date_added)
        VALUES (?,?,?,?,?,?,?)
      `).run(
        id, sanitize(label, 64), exchange,
        encrypt(apiKey), encrypt(apiSecret),
        passphrase ? encrypt(passphrase) : null,
        Date.now()
      );
      res.status(201).json({ id, label, exchange });
    } catch (err) {
      logger.error(`POST /accounts: ${err.message}`);
      res.status(500).json({ error: 'Failed to save account' });
    }
  }
);

// DELETE /api/keys/accounts/:id
router.delete('/accounts/:id', param('id').isString(), validate, (req, res) => {
  try {
    getDb().prepare('DELETE FROM exchange_accounts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ── ALERTS ────────────────────────────────────────────────────
router.get('/alerts', (req, res) => {
  try {
    res.json(getDb().prepare('SELECT * FROM price_alerts ORDER BY created_at DESC').all().map(a => ({
      id: a.id, coinId: a.coin_id, symbol: a.symbol,
      targetPrice: a.target_price, direction: a.direction,
      status: a.status, note: a.note,
      createdAt: a.created_at, triggeredAt: a.triggered_at,
    })));
  } catch (err) { res.status(500).json({ error: 'DB error' }); }
});

router.post('/alerts',
  body('coinId').isString(),
  body('symbol').isString().isLength({ max: 20 }),
  body('targetPrice').isFloat({ min: 0 }),
  body('direction').isIn(['ABOVE','BELOW']),
  body('note').optional().isString().isLength({ max: 256 }),
  validate,
  (req, res) => {
    try {
      const { coinId, symbol, targetPrice, direction, note } = req.body;
      const id = 'al_' + crypto.randomBytes(6).toString('hex');
      getDb().prepare(
        'INSERT INTO price_alerts (id,coin_id,symbol,target_price,direction,status,note,created_at) VALUES (?,?,?,?,?,?,?,?)'
      ).run(id, coinId, symbol.toUpperCase(), parseFloat(targetPrice), direction, 'ACTIVE', note || null, Date.now());
      res.status(201).json({ id });
    } catch (err) { res.status(500).json({ error: 'Failed to save alert' }); }
  }
);

router.patch('/alerts/:id/toggle', (req, res) => {
  try {
    const alert = getDb().prepare('SELECT * FROM price_alerts WHERE id = ?').get(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    const newStatus = alert.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    getDb().prepare('UPDATE price_alerts SET status = ? WHERE id = ?').run(newStatus, req.params.id);
    res.json({ status: newStatus });
  } catch (err) { res.status(500).json({ error: 'Failed to toggle alert' }); }
});

router.delete('/alerts/:id', (req, res) => {
  try {
    getDb().prepare('DELETE FROM price_alerts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete alert' }); }
});

module.exports = router;
