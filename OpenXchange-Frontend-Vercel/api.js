// ════ api.js — Updated for real backend ════
// Calls the Node.js backend for live data.
// Falls back to mock data if backend is unreachable (dev mode).

const API = (() => {
  // Auto-detect backend URL.
  // In production: same origin (backend serves the frontend).
  // In dev: can override with ?backend=http://localhost:3001
  const urlParams = new URLSearchParams(window.location.search);
  const BASE = urlParams.get('backend') ||
    (window.location.port === '3001' ? '' : window.location.origin.replace(/:\d+$/, ':3001'));

  let priceCache = {};
  let priceCacheTime = 0;
  const CACHE_TTL = 60000;

  // ── HTTP helper with mock fallback ──────────────────────────
  async function get(path, mockFallback) {
    try {
      const res = await fetch(`${BASE}/api${path}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn(`Backend unreachable (${path}): ${err.message} — using mock data`);
      if (typeof mockFallback === 'function') return mockFallback();
      return mockFallback;
    }
  }

  async function post(path, body) {
    const res = await fetch(`${BASE}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function del(path) {
    const res = await fetch(`${BASE}/api${path}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Map local storage wallet index to mock key ──────────────
  function walletMockKey(walletId) {
    const wallets = Storage.getWallets();
    const idx = wallets.findIndex(w => w.id === walletId);
    return `w${idx + 1}`;
  }
  function accountMockKey(accountId) {
    const accounts = Storage.getAccounts();
    const idx = accounts.findIndex(a => a.id === accountId);
    return `ex${idx + 1}`;
  }

  return {
    // ── Prices (live via backend → CoinGecko) ─────────────────
    async getPrices() {
      const now = Date.now();
      if (now - priceCacheTime < CACHE_TTL && Object.keys(priceCache).length) return priceCache;
      const data = await get('/prices', () => MOCK.prices);
      priceCache = data;
      priceCacheTime = Date.now();
      return priceCache;
    },

    // ── Wallets (live via backend → Moralis/Blockchair/etc.) ──
    async getWalletBalances(walletId) {
      const data = await get(`/wallets/${walletId}/balances`, () => {
        const key = walletMockKey(walletId);
        return { balances: MOCK.walletBalances[key] || [] };
      });
      return data.balances || data;
    },

    async getWalletTransactions(walletId) {
      const data = await get(`/wallets/${walletId}/transactions`, () => {
        const key = walletMockKey(walletId);
        return { transactions: MOCK.transactions[key] || [] };
      });
      return data.transactions || data;
    },

    async getAllTransactions() {
      const wallets = Storage.getWallets();
      const all = [];
      for (const w of wallets) {
        try {
          const txs = await this.getWalletTransactions(w.id);
          txs.forEach(t => all.push({ ...t, walletId: w.id, walletLabel: w.label }));
        } catch {}
      }
      return all.sort((a, b) => b.timestamp - a.timestamp);
    },

    // ── Exchanges (live via backend — HMAC signing server-side) ─
    async getExchangeBalances(accountId) {
      const data = await get(`/exchanges/${accountId}/balances`, () => {
        const key = accountMockKey(accountId);
        return { balances: MOCK.exchangeBalances[key] || {} };
      });
      return data.balances || data;
    },

    async getExchangeTransfers(accountId) {
      const data = await get(`/exchanges/${accountId}/transfers`, () => {
        const key = accountMockKey(accountId);
        return { transfers: MOCK.transfers[key] || [] };
      });
      return data.transfers || data;
    },

    async getAllExchangeTransfers() {
      const accounts = Storage.getAccounts();
      const all = [];
      for (const a of accounts) {
        try {
          const transfers = await this.getExchangeTransfers(a.id);
          transfers.forEach(t => all.push({ ...t, accountId: a.id, exchangeLabel: a.label, exchange: a.exchange }));
        } catch {}
      }
      return all.sort((a, b) => b.timestamp - a.timestamp);
    },

    async getPositions(accountId) {
      const data = await get(`/exchanges/${accountId}/positions`, () => {
        const key = accountMockKey(accountId);
        return { positions: MOCK.positions[key] || [] };
      });
      return data.positions || data;
    },

    async getAllPositions() {
      const accounts = Storage.getAccounts();
      const all = [];
      for (const a of accounts) {
        try {
          const pos = await this.getPositions(a.id);
          pos.forEach(p => all.push({ ...p, accountId: a.id, exchangeLabel: a.label, exchange: a.exchange }));
        } catch {}
      }
      return all;
    },

    // ── NFTs (live via backend → Moralis) ─────────────────────
    async getNFTs(walletId) {
      const data = await get(`/nfts/${walletId}`, () => {
        const key = walletMockKey(walletId);
        return { nfts: MOCK.nfts[key] || [] };
      });
      return data.nfts || data;
    },

    // ── Staking & Snapshots (static / local calc) ─────────────
    getStaking()   { return MOCK.staking;   },
    getSnapshots() { return MOCK.snapshots; },

    // ── Backend health check ───────────────────────────────────
    async isBackendOnline() {
      try {
        const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch { return false; }
    },

    // ── Key management (save to backend DB, not localStorage) ─
    async saveWallet(label, address, chain) {
      try {
        return await post('/keys/wallets', { label, address, chain });
      } catch (err) {
        // Fallback to localStorage if backend down
        return Storage.addWallet(label, address, chain);
      }
    },

    async deleteWallet(id) {
      try { await del(`/keys/wallets/${id}`); } catch {}
      Storage.deleteWallet(id);
    },

    async saveAccount(label, exchange, apiKey, apiSecret, passphrase) {
      return post('/keys/accounts', { label, exchange, apiKey, apiSecret, passphrase });
    },

    async deleteAccount(id) {
      try { await del(`/keys/accounts/${id}`); } catch {}
      Storage.deleteAccount(id);
    },

    async getBackendWallets() {
      const data = await get('/keys/wallets', () => Storage.getWallets());
      return Array.isArray(data) ? data : Storage.getWallets();
    },

    async getBackendAccounts() {
      const data = await get('/keys/accounts', () => Storage.getAccounts());
      return Array.isArray(data) ? data : Storage.getAccounts();
    },
  };
})();
