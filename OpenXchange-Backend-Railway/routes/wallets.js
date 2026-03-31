// ── /api/wallets ──────────────────────────────────────────────
const router  = require('express').Router();
const { param, validationResult } = require('express-validator');
const { getWalletData } = require('../services/blockchain');
const { getDb } = require('../config/database');
const logger  = require('../config/logger');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// GET /api/wallets/:id/balances
router.get('/:id/balances', param('id').isString(), validate, async (req, res) => {
  try {
    let wallet;
    try {
      wallet = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
    } catch(dbErr) {
      logger.warn(`DB not available, using request params: ${dbErr.message}`);
    }

    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found', id: req.params.id });
    }

    logger.info(`Syncing wallet: ${wallet.label} (${wallet.chain}) ${wallet.address}`);
    const data = await getWalletData(wallet.address, wallet.chain);

    // Update last_synced
    try {
      getDb().prepare('UPDATE wallets SET last_synced = ? WHERE id = ?').run(Date.now(), wallet.id);
    } catch(e) {}

    logger.info(`Wallet synced: ${data.balances.length} balances found for ${wallet.label}`);

    res.json({
      walletId:   wallet.id,
      label:      wallet.label,
      chain:      wallet.chain,
      address:    wallet.address,
      balances:   data.balances,
      lastSynced: Date.now(),
    });
  } catch (err) {
    logger.error(`Wallet balances error [${req.params.id}]: ${err.message}`);
    res.status(502).json({ error: `Failed to fetch wallet data: ${err.message}` });
  }
});

// GET /api/wallets/:id/transactions
router.get('/:id/transactions', param('id').isString(), validate, async (req, res) => {
  try {
    const wallet = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const data = await getWalletData(wallet.address, wallet.chain);
    res.json({ walletId: wallet.id, transactions: data.transactions });
  } catch (err) {
    logger.error(`Wallet transactions error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/wallets/:id — balances + transactions combined
router.get('/:id', param('id').isString(), validate, async (req, res) => {
  try {
    const wallet = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const data = await getWalletData(wallet.address, wallet.chain);
    try { getDb().prepare('UPDATE wallets SET last_synced = ? WHERE id = ?').run(Date.now(), wallet.id); } catch(e) {}

    res.json({
      walletId: wallet.id, label: wallet.label,
      chain: wallet.chain, address: wallet.address,
      balances: data.balances, transactions: data.transactions,
      lastSynced: Date.now(),
    });
  } catch (err) {
    logger.error(`Wallet full data error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
