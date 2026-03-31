// ════════════════════════════════════════════════════════════
//  Blockchain Data Service - Fixed Version
//  Chains: Bitcoin, Ethereum+EVM (7 chains), Solana, Tron
// ════════════════════════════════════════════════════════════
const axios  = require('axios');
const logger = require('../config/logger');

const MORALIS_KEY = process.env.MORALIS_API_KEY || '';

// EVM chain IDs for Moralis
const CHAIN_IDS = {
  ETHEREUM:  '0x1',
  BSC:       '0x38',
  POLYGON:   '0x89',
  ARBITRUM:  '0xa4b1',
  OPTIMISM:  '0xa',
  BASE:      '0x2105',
  AVALANCHE: '0xa86a',
};

// Coin ID map for CoinGecko price lookup
const COINGECKO_IDS = {
  ETH:'ethereum', BTC:'bitcoin', BNB:'binancecoin', SOL:'solana',
  MATIC:'matic-network', AVAX:'avalanche-2', TRX:'tron',
  ARB:'arbitrum', OP:'optimism', USDT:'tether', USDC:'usd-coin',
  LINK:'chainlink', UNI:'uniswap', AAVE:'aave', WBTC:'wrapped-bitcoin',
  SHIB:'shiba-inu', DOGE:'dogecoin',
};

// Price cache
const priceCache = new Map();
const PRICE_TTL  = 60000;

async function getPrice(coinId) {
  if (!coinId) return 0;
  const cached = priceCache.get(coinId);
  if (cached && Date.now() - cached.ts < PRICE_TTL) return cached.usd;
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: coinId, vs_currencies: 'usd' }, timeout: 8000,
    });
    const usd = res.data?.[coinId]?.usd || 0;
    priceCache.set(coinId, { usd, ts: Date.now() });
    return usd;
  } catch { return 0; }
}

// Safe HTTP GET
async function safeGet(url, headers = {}, params = {}) {
  try {
    const res = await axios.get(url, { headers, params, timeout: 15000 });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    logger.warn(`Blockchain fetch [${status}]: ${msg} — ${url.split('?')[0]}`);
    return null;
  }
}

// ── Bitcoin (Blockchair) ──────────────────────────────────────
async function getBitcoinData(address) {
  const data = await safeGet(`https://api.blockchair.com/bitcoin/dashboards/address/${address}`);
  if (!data?.data?.[address]) {
    logger.warn(`Bitcoin: no data for ${address}`);
    return { balances: [], transactions: [] };
  }

  const info       = data.data[address].address;
  const balanceSat = info.balance || 0;
  const btcPrice   = await getPrice('bitcoin');
  const balanceBtc = balanceSat / 1e8;

  const txHashes = (data.data[address].transactions || []).slice(0, 10);
  const transactions = [];

  for (const txHash of txHashes) {
    const txData = await safeGet(`https://api.blockchair.com/bitcoin/dashboards/transaction/${txHash}`);
    if (!txData?.data?.[txHash]) continue;
    const tx        = txData.data[txHash].transaction;
    const outputs   = txData.data[txHash].outputs || [];
    const inputs    = txData.data[txHash].inputs  || [];
    const isReceive = outputs.some(o => o.recipient === address);
    const value     = isReceive
      ? outputs.filter(o => o.recipient === address).reduce((s, o) => s + o.value, 0) / 1e8
      : inputs.filter(i => i.recipient === address).reduce((s, i) => s + i.value, 0) / 1e8;

    transactions.push({
      id: txHash, hash: txHash, chain: 'BITCOIN',
      type: isReceive ? 'RECEIVE' : 'SEND', status: 'CONFIRMED',
      timestamp: new Date(tx.time).getTime(),
      from: isReceive ? 'External' : address,
      to:   isReceive ? address : 'External',
      value, tokenSymbol: null,
      fee: (tx.fee || 0) / 1e8,
      valueUsd: value * btcPrice,
      feeUsd: ((tx.fee || 0) / 1e8) * btcPrice,
    });
  }

  return {
    balances: balanceBtc > 0 ? [{
      symbol: 'BTC', name: 'Bitcoin',
      balance: balanceBtc, decimals: 8,
      priceUsd: btcPrice, valueUsd: balanceBtc * btcPrice,
      contract: null, logo: '₿',
    }] : [],
    transactions,
  };
}

// ── EVM chains (Moralis) ──────────────────────────────────────
async function getEvmData(address, chain) {
  if (!MORALIS_KEY) {
    logger.warn('MORALIS_API_KEY not set — cannot fetch EVM data');
    return { balances: [], transactions: [] };
  }

  const chainId = CHAIN_IDS[chain] || '0x1';
  const headers = { 'X-API-Key': MORALIS_KEY };
  const base    = 'https://deep-index.moralis.io/api/v2.2';

  logger.info(`Fetching EVM data: chain=${chain} chainId=${chainId} address=${address.slice(0,10)}...`);

  // Fetch all in parallel
  const [nativeRes, tokenRes, txRes] = await Promise.allSettled([
    axios.get(`${base}/${address}/balance`, { headers, params: { chain: chainId }, timeout: 15000 }),
    axios.get(`${base}/${address}/erc20`,   { headers, params: { chain: chainId }, timeout: 15000 }),
    axios.get(`${base}/${address}`,          { headers, params: { chain: chainId, limit: 25 }, timeout: 15000 }),
  ]);

  // Log any errors
  if (nativeRes.status === 'rejected') logger.error(`Native balance error: ${nativeRes.reason?.response?.data?.message || nativeRes.reason?.message}`);
  if (tokenRes.status  === 'rejected') logger.error(`Token balance error: ${tokenRes.reason?.response?.data?.message  || tokenRes.reason?.message}`);
  if (txRes.status     === 'rejected') logger.error(`Transaction error: ${txRes.reason?.response?.data?.message       || txRes.reason?.message}`);

  const NATIVE_SYMBOLS = {
    ETHEREUM:'ETH', BSC:'BNB', POLYGON:'MATIC',
    ARBITRUM:'ETH', OPTIMISM:'ETH', BASE:'ETH', AVALANCHE:'AVAX',
  };
  const nativeSym     = NATIVE_SYMBOLS[chain] || 'ETH';
  const nativeCgId    = COINGECKO_IDS[nativeSym] || nativeSym.toLowerCase();
  const nativePrice   = await getPrice(nativeCgId);
  const nativeBalance = nativeRes.status === 'fulfilled'
    ? parseFloat(nativeRes.value.data?.balance || '0') / 1e18
    : 0;

  const balances = [];

  if (nativeBalance > 0) {
    balances.push({
      symbol: nativeSym, name: chain === 'BSC' ? 'BNB' : nativeSym,
      balance: nativeBalance, decimals: 18,
      priceUsd: nativePrice, valueUsd: nativeBalance * nativePrice,
      contract: null, logo: null,
    });
  }

  const tokens = tokenRes.status === 'fulfilled' ? (tokenRes.value.data || []) : [];
  for (const token of tokens) {
    const bal = parseFloat(token.balance || '0') / Math.pow(10, parseInt(token.decimals || 18));
    if (bal <= 0) continue;
    const sym   = (token.symbol || '?').toUpperCase();
    const cgId  = COINGECKO_IDS[sym];
    const price = cgId ? await getPrice(cgId) : 0;
    balances.push({
      symbol: sym, name: token.name || sym,
      balance: bal, decimals: parseInt(token.decimals || 18),
      priceUsd: price, valueUsd: bal * price,
      contract: token.token_address, logo: token.logo || null,
    });
  }

  const txData       = txRes.status === 'fulfilled' ? txRes.value.data : null;
  const transactions = (txData?.result || []).map(tx => {
    const isReceive = (tx.to_address || '').toLowerCase() === address.toLowerCase();
    const value     = parseFloat(tx.value || '0') / 1e18;
    const gasUsed   = parseFloat(tx.receipt_gas_used || tx.gas || '0');
    const gasPrice  = parseFloat(tx.gas_price || '0') / 1e18;
    const fee       = gasUsed * gasPrice;
    return {
      id: tx.hash, hash: tx.hash, chain,
      type: isReceive ? 'RECEIVE' : 'SEND',
      status: tx.receipt_status === '1' ? 'CONFIRMED' : 'FAILED',
      timestamp: new Date(tx.block_timestamp).getTime(),
      from: tx.from_address, to: tx.to_address,
      value, tokenSymbol: null,
      fee, valueUsd: value * nativePrice, feeUsd: fee * nativePrice,
    };
  });

  logger.info(`EVM result: ${balances.length} balances, ${transactions.length} transactions`);
  return { balances, transactions };
}

// ── Solana (Moralis) ──────────────────────────────────────────
async function getSolanaData(address) {
  if (!MORALIS_KEY) return { balances: [], transactions: [] };

  const headers = { 'X-API-Key': MORALIS_KEY };
  const base    = 'https://solana-gateway.moralis.io/account/mainnet';

  const [portfolioRes, txRes] = await Promise.allSettled([
    axios.get(`${base}/${address}/portfolio`, { headers, timeout: 15000 }),
    axios.get(`${base}/${address}/transfers`, { headers, timeout: 15000 }),
  ]);

  const solPrice = await getPrice('solana');
  const pData    = portfolioRes.status === 'fulfilled' ? portfolioRes.value.data : null;
  const nativeSol = parseFloat(pData?.nativeBalance?.solana || '0');

  const balances = [];
  if (nativeSol > 0) {
    balances.push({
      symbol: 'SOL', name: 'Solana',
      balance: nativeSol, decimals: 9,
      priceUsd: solPrice, valueUsd: nativeSol * solPrice,
      contract: null, logo: '◎',
    });
  }

  for (const token of (pData?.tokens || [])) {
    const bal = parseFloat(token.amount || '0');
    if (bal <= 0) continue;
    balances.push({
      symbol: token.symbol || '?', name: token.name || token.symbol || '?',
      balance: bal, decimals: token.decimals || 9,
      priceUsd: 0, valueUsd: 0,
      contract: token.mint, logo: null,
    });
  }

  const txData       = txRes.status === 'fulfilled' ? txRes.value.data : null;
  const transactions = (txData?.result || []).slice(0, 20).map(tx => ({
    id: tx.signature, hash: tx.signature, chain: 'SOLANA',
    type: tx.toAddress === address ? 'RECEIVE' : 'SEND',
    status: 'CONFIRMED',
    timestamp: (tx.blockTime || 0) * 1000,
    from: tx.fromAddress, to: tx.toAddress,
    value: parseFloat(tx.value || '0'), tokenSymbol: tx.tokenSymbol || null,
    fee: 0.000005, valueUsd: 0, feeUsd: 0.000005 * solPrice,
  }));

  return { balances, transactions };
}

// ── Tron (TronScan) ───────────────────────────────────────────
async function getTronData(address) {
  const data = await safeGet(`https://apilist.tronscan.org/api/account?address=${address}`);
  if (!data) return { balances: [], transactions: [] };

  const trxPrice   = await getPrice('tron');
  const trxBalance = parseFloat(data.balance || '0') / 1e6;
  const balances   = [];

  if (trxBalance > 0) {
    balances.push({
      symbol: 'TRX', name: 'Tron',
      balance: trxBalance, decimals: 6,
      priceUsd: trxPrice, valueUsd: trxBalance * trxPrice,
      contract: null, logo: 'T',
    });
  }

  for (const token of (data.trc20token_balances || []).slice(0, 20)) {
    const bal = parseFloat(token.balance || '0') / Math.pow(10, parseInt(token.tokenDecimal || 6));
    if (bal <= 0) continue;
    const sym   = (token.tokenAbbr || '?').toUpperCase();
    const price = COINGECKO_IDS[sym] ? await getPrice(COINGECKO_IDS[sym]) : 0;
    balances.push({
      symbol: sym, name: token.tokenName || sym,
      balance: bal, decimals: parseInt(token.tokenDecimal || 6),
      priceUsd: price, valueUsd: bal * price,
      contract: token.tokenId, logo: null,
    });
  }

  const txData = await safeGet(`https://apilist.tronscan.org/api/transaction?address=${address}&limit=20`);
  const transactions = (txData?.data || []).map(tx => {
    const isReceive = tx.toAddress === address;
    const value     = parseFloat(tx.amount || '0') / 1e6;
    return {
      id: tx.hash, hash: tx.hash, chain: 'TRON',
      type: isReceive ? 'RECEIVE' : 'SEND',
      status: tx.confirmed ? 'CONFIRMED' : 'PENDING',
      timestamp: tx.timestamp,
      from: tx.ownerAddress, to: tx.toAddress,
      value, tokenSymbol: null,
      fee: parseFloat(tx.cost?.net_fee || '0') / 1e6,
      valueUsd: value * trxPrice, feeUsd: 0,
    };
  });

  return { balances, transactions };
}

// ── Main dispatcher ───────────────────────────────────────────
async function getWalletData(address, chain) {
  logger.info(`getWalletData: ${chain} — ${address}`);
  try {
    switch (chain) {
      case 'BITCOIN':   return await getBitcoinData(address);
      case 'SOLANA':    return await getSolanaData(address);
      case 'TRON':      return await getTronData(address);
      default:          return await getEvmData(address, chain);
    }
  } catch (err) {
    logger.error(`getWalletData failed for ${chain}:${address} — ${err.message}`);
    return { balances: [], transactions: [] };
  }
}

module.exports = { getWalletData };
