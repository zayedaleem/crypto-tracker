// ── /api/exchanges ────────────────────────────────────────────
const router  = require('express').Router();
const { param, validationResult } = require('express-validator');
const { getExchangeData } = require('../services/exchangeSigning');
const { decrypt } = require('../config/encryption');
const { getDb }   = require('../config/database');
const logger = require('../config/logger');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

function getAccount(id) {
  const a = getDb().prepare('SELECT * FROM exchange_accounts WHERE id = ?').get(id);
  if (!a) throw new Error('Account not found');
  return {
    id: a.id, label: a.label, exchange: a.exchange,
    apiKey:     decrypt(a.api_key_enc),
    apiSecret:  decrypt(a.api_sec_enc),
    passphrase: a.passphrase_enc ? decrypt(a.passphrase_enc) : null,
    lastSynced: a.last_synced,
  };
}

// GET /api/exchanges/:id/balances
router.get('/:id/balances', param('id').isString(), validate, async (req, res) => {
  try {
    const account = getAccount(req.params.id);
    logger.info(`Fetching balances: ${account.exchange} - ${account.label}`);
    const data = await getExchangeData(
      account.exchange, account.apiKey, account.apiSecret,
      account.passphrase, 'balances'
    );
    getDb().prepare('UPDATE exchange_accounts SET last_synced = ? WHERE id = ?').run(Date.now(), account.id);
    res.json({ accountId: account.id, label: account.label, exchange: account.exchange, balances: data });
  } catch (err) {
    logger.error(`Exchange balances [${req.params.id}]: ${err.message}`);
    // Return 200 with error info so frontend can show it gracefully
    res.json({ 
      accountId: req.params.id, 
      balances: {}, 
      error: err.message,
      hint: getHint(err.message)
    });
  }
});

// GET /api/exchanges/:id/transfers
router.get('/:id/transfers', param('id').isString(), validate, async (req, res) => {
  try {
    const account = getAccount(req.params.id);
    const data = await getExchangeData(
      account.exchange, account.apiKey, account.apiSecret,
      account.passphrase, 'transfers'
    );
    res.json({ accountId: account.id, transfers: data });
  } catch (err) {
    logger.error(`Exchange transfers [${req.params.id}]: ${err.message}`);
    res.json({ accountId: req.params.id, transfers: [], error: err.message });
  }
});

// GET /api/exchanges/:id/positions
router.get('/:id/positions', param('id').isString(), validate, async (req, res) => {
  try {
    const account = getAccount(req.params.id);
    const exchanges_with_positions = ['BINANCE', 'BYBIT', 'OKX'];
    if (!exchanges_with_positions.includes(account.exchange)) {
      return res.json({ accountId: account.id, positions: [] });
    }
    const data = await getExchangeData(
      account.exchange, account.apiKey, account.apiSecret,
      account.passphrase, 'positions'
    );
    res.json({ accountId: account.id, positions: data });
  } catch (err) {
    logger.error(`Exchange positions [${req.params.id}]: ${err.message}`);
    res.json({ accountId: req.params.id, positions: [], error: err.message });
  }
});

// GET /api/exchanges/:id — all data in one call
router.get('/:id', param('id').isString(), validate, async (req, res) => {
  try {
    const account = getAccount(req.params.id);
    const [balances, transfers, positions] = await Promise.allSettled([
      getExchangeData(account.exchange, account.apiKey, account.apiSecret, account.passphrase, 'balances'),
      getExchangeData(account.exchange, account.apiKey, account.apiSecret, account.passphrase, 'transfers'),
      ['BINANCE','BYBIT','OKX'].includes(account.exchange)
        ? getExchangeData(account.exchange, account.apiKey, account.apiSecret, account.passphrase, 'positions')
        : Promise.resolve([]),
    ]);
    getDb().prepare('UPDATE exchange_accounts SET last_synced = ? WHERE id = ?').run(Date.now(), account.id);
    res.json({
      accountId:  account.id,
      label:      account.label,
      exchange:   account.exchange,
      balances:   balances.status  === 'fulfilled' ? balances.value  : {},
      transfers:  transfers.status === 'fulfilled' ? transfers.value : [],
      positions:  positions.status === 'fulfilled' ? positions.value : [],
      errors: [balances, transfers, positions]
        .filter(r => r.status === 'rejected')
        .map(r => r.reason?.message || String(r.reason)),
    });
  } catch (err) {
    logger.error(`Exchange full [${req.params.id}]: ${err.message}`);
    res.status(502).json({ error: err.message, hint: getHint(err.message) });
  }
});

// Provide helpful hints based on error message
function getHint(msg) {
  if (!msg) return null;
  if (msg.includes('400') || msg.includes('Bad Request'))
    return 'Check your API key, secret, and passphrase are correct';
  if (msg.includes('401') || msg.includes('Unauthorized'))  
    return 'Invalid API credentials - check key/secret/passphrase';
  if (msg.includes('403') || msg.includes('Forbidden'))
    return 'API key does not have permission - enable General (read) access in KuCoin';
  if (msg.includes('502') || msg.includes('Bad Gateway'))
    return 'KuCoin rejected the request - your IP may need to be whitelisted, or check your API key permissions';
  if (msg.includes('IP'))
    return 'Whitelist your IP address in the exchange API settings, or set to allow all IPs';
  return 'Check your API key settings on the exchange';
}

module.exports = router;
