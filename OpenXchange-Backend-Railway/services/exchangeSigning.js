// ════════════════════════════════════════════════════════════
//  Exchange API Signing Service
//  Handles HMAC-SHA256 signing for Binance, Bybit, KuCoin,
//  Gate.io and OKX — all done server-side, keys never exposed
// ════════════════════════════════════════════════════════════
const crypto = require('crypto');
const axios  = require('axios');
const logger = require('../config/logger');

// ── Utility ───────────────────────────────────────────────────
const hmac256hex    = (msg, secret) => crypto.createHmac('sha256', secret).update(msg).digest('hex');
const hmac256base64 = (msg, secret) => crypto.createHmac('sha256', secret).update(msg).digest('base64');
const hmac512hex    = (msg, secret) => crypto.createHmac('sha512', secret).update(msg).digest('hex');
const now           = () => Date.now().toString();
const nowSec        = () => Math.floor(Date.now() / 1000).toString();

function buildQuery(params) {
  return Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ── Base request with error handling ─────────────────────────
async function request(config) {
  try {
    const res = await axios({ timeout: 15000, ...config });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.msg || err.response?.data?.message || err.message;
    logger.error(`Exchange request failed [${status}]: ${msg} — ${config.url}`);
    throw new Error(`Exchange API error ${status}: ${msg}`);
  }
}

// ═══════════════════════════════════
//  BINANCE  (HMAC-SHA256 hex)
// ═══════════════════════════════════
const Binance = {
  BASE: 'https://api.binance.com',

  sign(params, secret) {
    const qs = buildQuery({ ...params, timestamp: now() });
    return `${qs}&signature=${hmac256hex(qs, secret)}`;
  },

  headers(apiKey) {
    return { 'X-MBX-APIKEY': apiKey };
  },

  async getSpotBalances(apiKey, apiSecret) {
    const qs   = this.sign({}, apiSecret);
    const data = await request({
      url: `${this.BASE}/api/v3/account?${qs}`,
      headers: this.headers(apiKey),
    });
    return (data.balances || [])
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({
        asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked),
        accountType: 'SPOT',
      }));
  },

  async getFuturesBalances(apiKey, apiSecret) {
    const qs   = this.sign({}, apiSecret);
    const data = await request({
      url: `https://fapi.binance.com/fapi/v2/account?${qs}`,
      headers: this.headers(apiKey),
    });
    return (data.assets || [])
      .filter(a => parseFloat(a.walletBalance) > 0)
      .map(a => ({
        asset: a.asset, free: parseFloat(a.availableBalance),
        locked: parseFloat(a.walletBalance) - parseFloat(a.availableBalance),
        accountType: 'FUTURES',
      }));
  },

  async getPositions(apiKey, apiSecret) {
    const qs   = this.sign({}, apiSecret);
    const data = await request({
      url: `https://fapi.binance.com/fapi/v2/positionRisk?${qs}`,
      headers: this.headers(apiKey),
    });
    return (data || [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side:   parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        size:   Math.abs(parseFloat(p.positionAmt)),
        entryPrice:       parseFloat(p.entryPrice),
        markPrice:        parseFloat(p.markPrice),
        liquidationPrice: parseFloat(p.liquidationPrice),
        leverage:         parseFloat(p.leverage),
        unrealizedPnl:    parseFloat(p.unRealizedProfit),
        unrealizedPnlPct: parseFloat(p.entryPrice) > 0
          ? ((parseFloat(p.markPrice) - parseFloat(p.entryPrice)) / parseFloat(p.entryPrice) * 100 * (parseFloat(p.positionAmt) > 0 ? 1 : -1))
          : 0,
        margin: parseFloat(p.isolatedMargin) || 0,
      }));
  },

  async getDeposits(apiKey, apiSecret, days = 90) {
    const startTime = Date.now() - days * 86400000;
    const qs   = this.sign({ startTime }, apiSecret);
    const data = await request({
      url: `${this.BASE}/sapi/v1/capital/deposit/hisrec?${qs}`,
      headers: this.headers(apiKey),
    });
    return (data || []).map(d => ({
      id: d.id || d.txId, type: 'DEPOSIT', asset: d.coin,
      amount: parseFloat(d.amount), fee: 0, feeAsset: d.coin,
      timestamp: d.insertTime, status: d.statusMsg || 'Confirmed',
      txHash: d.txId, address: d.address,
      fromAccount: null, toAccount: 'Spot',
    }));
  },

  async getWithdrawals(apiKey, apiSecret, days = 90) {
    const startTime = Date.now() - days * 86400000;
    const qs   = this.sign({ startTime }, apiSecret);
    const data = await request({
      url: `${this.BASE}/sapi/v1/capital/withdraw/history?${qs}`,
      headers: this.headers(apiKey),
    });
    return (data || []).map(w => ({
      id: w.id, type: 'WITHDRAWAL', asset: w.coin,
      amount: parseFloat(w.amount), fee: parseFloat(w.transactionFee || 0), feeAsset: w.coin,
      timestamp: w.applyTime, status: w.statusMsg || 'Confirmed',
      txHash: w.txId, address: w.address,
      fromAccount: 'Spot', toAccount: null,
    }));
  },
};

// ═══════════════════════════════════
//  BYBIT  (HMAC-SHA256 hex, V5 API)
// ═══════════════════════════════════
const Bybit = {
  BASE: 'https://api.bybit.com',

  sign(params, apiKey, apiSecret) {
    const ts      = now();
    const recvWindow = '5000';
    const payload = `${ts}${apiKey}${recvWindow}${buildQuery(params)}`;
    return {
      'X-BAPI-API-KEY':    apiKey,
      'X-BAPI-TIMESTAMP':  ts,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN':       hmac256hex(payload, apiSecret),
    };
  },

  async getBalances(apiKey, apiSecret, accountType = 'UNIFIED') {
    const params  = { accountType };
    const headers = this.sign(params, apiKey, apiSecret);
    const data    = await request({
      url: `${this.BASE}/v5/account/wallet-balance?${buildQuery(params)}`,
      headers,
    });
    const coins = data?.result?.list?.[0]?.coin || [];
    return coins
      .filter(c => parseFloat(c.walletBalance) > 0)
      .map(c => ({
        asset: c.coin,
        free:   parseFloat(c.availableToWithdraw || c.availableToBorrow || 0),
        locked: parseFloat(c.walletBalance) - parseFloat(c.availableToWithdraw || 0),
        accountType,
      }));
  },

  async getPositions(apiKey, apiSecret) {
    const params  = { category: 'linear', settleCoin: 'USDT', limit: '200' };
    const headers = this.sign(params, apiKey, apiSecret);
    const data    = await request({
      url: `${this.BASE}/v5/position/list?${buildQuery(params)}`,
      headers,
    });
    return (data?.result?.list || [])
      .filter(p => parseFloat(p.size) > 0)
      .map(p => ({
        symbol: p.symbol,
        side:   p.side,
        size:   parseFloat(p.size),
        entryPrice:       parseFloat(p.avgPrice),
        markPrice:        parseFloat(p.markPrice),
        liquidationPrice: parseFloat(p.liqPrice),
        leverage:         parseFloat(p.leverage),
        unrealizedPnl:    parseFloat(p.unrealisedPnl),
        unrealizedPnlPct: parseFloat(p.unrealisedPnl) / (parseFloat(p.positionValue) || 1) * 100,
        margin: parseFloat(p.positionIM || 0),
      }));
  },

  async getTransfers(apiKey, apiSecret, days = 90) {
    const params  = { limit: '50', startTime: (Date.now() - days * 86400000).toString() };
    const headers = this.sign(params, apiKey, apiSecret);
    const data    = await request({
      url: `${this.BASE}/v5/asset/withdraw/query-record?${buildQuery(params)}`,
      headers,
    });
    return (data?.result?.rows || []).map(w => ({
      id: w.withdrawId, type: 'WITHDRAWAL', asset: w.coin,
      amount: parseFloat(w.amount), fee: parseFloat(w.withdrawFee || 0), feeAsset: w.coin,
      timestamp: parseInt(w.createTime), status: w.status,
      txHash: w.txID, address: w.toAddress,
      fromAccount: 'Spot', toAccount: null,
    }));
  },
};

// ═══════════════════════════════════
//  KUCOIN  (HMAC-SHA256 base64 + passphrase)
// ═══════════════════════════════════
const KuCoin = {
  BASE: 'https://api.kucoin.com',

  headers(apiKey, apiSecret, passphrase, method, endpoint, body = '') {
    const ts   = now();
    const what = `${ts}${method}${endpoint}${body}`;
    return {
      'KC-API-KEY':        apiKey,
      'KC-API-TIMESTAMP':  ts,
      'KC-API-SIGN':       hmac256base64(what, apiSecret),
      'KC-API-PASSPHRASE': hmac256base64(passphrase, apiSecret),
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json',
    };
  },

  async getBalances(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v1/accounts';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    return (data?.data || [])
      .filter(a => parseFloat(a.balance) > 0)
      .map(a => ({
        asset: a.currency,
        free:   parseFloat(a.available),
        locked: parseFloat(a.holds),
        accountType: a.type?.toUpperCase() || 'SPOT',
      }));
  },

  async getDeposits(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v1/deposits';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    return (data?.data?.items || []).map(d => ({
      id: d.id, type: 'DEPOSIT', asset: d.currency,
      amount: parseFloat(d.amount), fee: parseFloat(d.fee || 0), feeAsset: d.currency,
      timestamp: d.createdAt, status: d.status,
      txHash: d.walletTxId, address: d.address,
      fromAccount: null, toAccount: 'Main',
    }));
  },

  async getWithdrawals(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v1/withdrawals';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    return (data?.data?.items || []).map(w => ({
      id: w.id, type: 'WITHDRAWAL', asset: w.currency,
      amount: parseFloat(w.amount), fee: parseFloat(w.fee || 0), feeAsset: w.currency,
      timestamp: w.createdAt, status: w.status,
      txHash: w.walletTxId, address: w.address,
      fromAccount: 'Main', toAccount: null,
    }));
  },
};

// ═══════════════════════════════════
//  GATE.IO  (HMAC-SHA512 hex)
// ═══════════════════════════════════
const GateIo = {
  BASE: 'https://api.gateio.ws/api/v4',

  headers(apiKey, apiSecret, method, url, body = '') {
    const ts      = nowSec();
    const bodyHash = crypto.createHash('sha512').update(body).digest('hex');
    const query   = url.includes('?') ? url.split('?')[1] : '';
    const path    = url.includes('?') ? url.split('?')[0] : url;
    const signStr = `${method}\n${path}\n${query}\n${bodyHash}\n${ts}`;
    return {
      'KEY':       apiKey,
      'SIGN':      hmac512hex(signStr, apiSecret),
      'Timestamp': ts,
      'Content-Type': 'application/json',
    };
  },

  async getSpotBalances(apiKey, apiSecret) {
    const ep   = '/spot/accounts';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, 'GET', ep),
    });
    return (data || [])
      .filter(b => parseFloat(b.available) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({
        asset: b.currency,
        free:   parseFloat(b.available),
        locked: parseFloat(b.locked),
        accountType: 'SPOT',
      }));
  },

  async getWithdrawals(apiKey, apiSecret) {
    const ep   = '/withdrawals?limit=100';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, 'GET', ep),
    });
    return (data || []).map(w => ({
      id: w.id, type: 'WITHDRAWAL', asset: w.currency,
      amount: parseFloat(w.amount), fee: parseFloat(w.fee || 0), feeAsset: w.currency,
      timestamp: w.timestamp * 1000, status: w.status,
      txHash: w.txid, address: w.address,
      fromAccount: 'Spot', toAccount: null,
    }));
  },
};

// ═══════════════════════════════════
//  OKX  (HMAC-SHA256 base64 + passphrase)
// ═══════════════════════════════════
const OKX = {
  BASE: 'https://www.okx.com',

  headers(apiKey, apiSecret, passphrase, method, path, body = '') {
    const ts   = new Date().toISOString();
    const what = `${ts}${method}${path}${body}`;
    return {
      'OK-ACCESS-KEY':        apiKey,
      'OK-ACCESS-SIGN':       hmac256base64(what, apiSecret),
      'OK-ACCESS-TIMESTAMP':  ts,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
    };
  },

  async getBalances(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v5/account/balance';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    const details = data?.data?.[0]?.details || [];
    return details
      .filter(d => parseFloat(d.cashBal) > 0)
      .map(d => ({
        asset: d.ccy,
        free:   parseFloat(d.availBal),
        locked: parseFloat(d.frozenBal),
        accountType: 'UNIFIED',
      }));
  },

  async getPositions(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v5/account/positions';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    return (data?.data || [])
      .filter(p => parseFloat(p.pos) !== 0)
      .map(p => ({
        symbol: p.instId,
        side:   parseFloat(p.pos) > 0 ? 'LONG' : 'SHORT',
        size:   Math.abs(parseFloat(p.pos)),
        entryPrice:       parseFloat(p.avgPx),
        markPrice:        parseFloat(p.markPx),
        liquidationPrice: parseFloat(p.liqPx),
        leverage:         parseFloat(p.lever),
        unrealizedPnl:    parseFloat(p.upl),
        unrealizedPnlPct: parseFloat(p.uplRatio) * 100,
        margin: parseFloat(p.imr || 0),
      }));
  },

  async getWithdrawals(apiKey, apiSecret, passphrase) {
    const ep   = '/api/v5/asset/withdrawal-history?limit=100';
    const data = await request({
      url: `${this.BASE}${ep}`,
      headers: this.headers(apiKey, apiSecret, passphrase, 'GET', ep),
    });
    return (data?.data || []).map(w => ({
      id: w.wdId, type: 'WITHDRAWAL', asset: w.ccy,
      amount: parseFloat(w.amt), fee: parseFloat(w.fee || 0), feeAsset: w.ccy,
      timestamp: parseInt(w.ts), status: w.state === '2' ? 'Confirmed' : w.state,
      txHash: w.txId, address: w.to,
      fromAccount: 'Trading', toAccount: null,
    }));
  },
};

// ── Dispatcher — routes to correct exchange ───────────────────
async function getExchangeData(exchange, apiKey, apiSecret, passphrase, dataType) {
  const ex = exchange.toUpperCase();

  switch (`${ex}:${dataType}`) {
    // Balances
    case 'BINANCE:balances': {
      const [spot, futures] = await Promise.allSettled([
        Binance.getSpotBalances(apiKey, apiSecret),
        Binance.getFuturesBalances(apiKey, apiSecret),
      ]);
      return {
        SPOT:    spot.status    === 'fulfilled' ? spot.value    : [],
        FUTURES: futures.status === 'fulfilled' ? futures.value : [],
      };
    }
    case 'BYBIT:balances': {
      const balances = await Bybit.getBalances(apiKey, apiSecret, 'UNIFIED');
      return { UNIFIED: balances };
    }
    case 'KUCOIN:balances': {
      const balances = await KuCoin.getBalances(apiKey, apiSecret, passphrase);
      const grouped  = {};
      balances.forEach(b => {
        if (!grouped[b.accountType]) grouped[b.accountType] = [];
        grouped[b.accountType].push(b);
      });
      return grouped;
    }
    case 'GATE_IO:balances': {
      const spot = await GateIo.getSpotBalances(apiKey, apiSecret);
      return { SPOT: spot };
    }
    case 'OKX:balances': {
      const balances = await OKX.getBalances(apiKey, apiSecret, passphrase);
      return { UNIFIED: balances };
    }

    // Positions
    case 'BINANCE:positions': return Binance.getPositions(apiKey, apiSecret);
    case 'BYBIT:positions':   return Bybit.getPositions(apiKey, apiSecret);
    case 'OKX:positions':     return OKX.getPositions(apiKey, apiSecret, passphrase);

    // Transfers (deposits + withdrawals combined)
    case 'BINANCE:transfers': {
      const [deps, wds] = await Promise.allSettled([
        Binance.getDeposits(apiKey, apiSecret),
        Binance.getWithdrawals(apiKey, apiSecret),
      ]);
      return [
        ...(deps.status === 'fulfilled' ? deps.value : []),
        ...(wds.status  === 'fulfilled' ? wds.value  : []),
      ].sort((a, b) => b.timestamp - a.timestamp);
    }
    case 'KUCOIN:transfers': {
      const [deps, wds] = await Promise.allSettled([
        KuCoin.getDeposits(apiKey, apiSecret, passphrase),
        KuCoin.getWithdrawals(apiKey, apiSecret, passphrase),
      ]);
      return [
        ...(deps.status === 'fulfilled' ? deps.value : []),
        ...(wds.status  === 'fulfilled' ? wds.value  : []),
      ].sort((a, b) => b.timestamp - a.timestamp);
    }
    case 'GATE_IO:transfers': return GateIo.getWithdrawals(apiKey, apiSecret);
    case 'BYBIT:transfers':   return Bybit.getTransfers(apiKey, apiSecret);
    case 'OKX:transfers':     return OKX.getWithdrawals(apiKey, apiSecret, passphrase);

    default:
      throw new Error(`Unsupported: ${ex}:${dataType}`);
  }
}

module.exports = { getExchangeData };
