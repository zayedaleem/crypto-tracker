// ── /api/test/kucoin — Debug endpoint ────────────────────────
const router  = require('express').Router();
const axios   = require('axios');
const crypto  = require('crypto');
const { decrypt } = require('../config/encryption');
const { getDb }   = require('../config/database');

router.get('/kucoin/:id', async (req, res) => {
  try {
    const a = getDb().prepare('SELECT * FROM exchange_accounts WHERE id = ?').get(req.params.id);
    if (!a) return res.send(`
      <html><head><style>body{font-family:monospace;background:#0d0d1a;color:#e0e0e0;padding:30px}
      h2{color:#ff5252} p{color:#ffa726;margin:10px 0} .fix{background:#1a1a2e;padding:20px;border-radius:8px;margin-top:20px;border:1px solid #00bfa5}
      </style></head><body>
      <h2>⚠️ Account Not In Database</h2>
      <p>This account (${req.params.id}) was saved in your browser but not in the server database.</p>
      <div class="fix">
        <strong style="color:#00bfa5">How to fix (takes 30 seconds):</strong><br><br>
        1. Go back to the tracker<br>
        2. Click <strong>Exchanges</strong> in the sidebar<br>
        3. Click the 🗑️ delete button on your KuCoin account<br>
        4. Click <strong>+ Connect Exchange</strong><br>
        5. Re-enter your KuCoin API details<br><br>
        This saves it properly to the database and everything will work.
      </div>
      </body></html>
    `);
    
    const apiKey    = decrypt(a.api_key_enc);
    const apiSecret = decrypt(a.api_sec_enc);
    const passphrase = a.passphrase_enc ? decrypt(a.passphrase_enc) : '';
    
    const ts   = Date.now().toString();
    const ep   = '/api/v1/accounts';
    const what = `${ts}GET${ep}`;
    const sign = crypto.createHmac('sha256', apiSecret).update(what).digest('base64');
    const passSigned = crypto.createHmac('sha256', apiSecret).update(passphrase).digest('base64');
    
    const response = await axios.get(`https://api.kucoin.com${ep}`, {
      headers: {
        'KC-API-KEY': apiKey,
        'KC-API-TIMESTAMP': ts,
        'KC-API-SIGN': sign,
        'KC-API-PASSPHRASE': passSigned,
        'KC-API-KEY-VERSION': '2',
        'Content-Type': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true, // Don't throw on any status
    });
    
    res.json({
      httpStatus: response.status,
      kuCoinCode: response.data?.code,
      kuCoinMsg:  response.data?.msg,
      dataPreview: JSON.stringify(response.data).slice(0, 500),
      keyUsed: apiKey.slice(0,8) + '...',
      hasPassphrase: !!passphrase,
    });
  } catch(err) {
    res.json({error: err.message, stack: err.stack?.slice(0,300)});
  }
});

module.exports = router;


// List all exchange accounts with test links
router.get('/accounts', async (req, res) => {
  try {
    const accounts = getDb().prepare('SELECT id, label, exchange FROM exchange_accounts').all();
    const html = `
      <html><head><style>
        body{font-family:monospace;background:#0d0d1a;color:#e0e0e0;padding:20px}
        h2{color:#00e5ff} table{border-collapse:collapse;width:100%}
        td,th{padding:10px;border:1px solid #2a2a4a;text-align:left}
        th{color:#888;font-size:.8rem} a{color:#00bfa5}
        .btn{display:inline-block;background:#00bfa5;color:#001820;padding:4px 10px;border-radius:4px;text-decoration:none;font-size:.8rem;margin:2px}
      </style></head><body>
        <h2>Exchange Accounts — API Diagnostics</h2>
        <table>
          <tr><th>Label</th><th>Exchange</th><th>Account ID</th><th>Test</th></tr>
          ${accounts.map(a => `
            <tr>
              <td>${a.label}</td>
              <td>${a.exchange}</td>
              <td style="font-size:.75rem">${a.id}</td>
              <td><a class="btn" href="/api/test/kucoin/${a.id}" target="_blank">🔍 Test API</a></td>
            </tr>`).join('')}
        </table>
        <p style="margin-top:20px;color:#666;font-size:.8rem">
          Click "Test API" to see the exact response from the exchange.
        </p>
      </body></html>
    `;
    res.send(html);
  } catch(err) {
    res.json({error: err.message});
  }
});
