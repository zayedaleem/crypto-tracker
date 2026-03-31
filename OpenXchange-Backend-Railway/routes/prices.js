// ── /api/prices ───────────────────────────────────────────────
const router = require('express').Router();
const axios  = require('axios');
const rateLimit = require('express-rate-limit');
const logger = require('../config/logger');

// Tight rate limit for price endpoint (CoinGecko free tier = 30 req/min)
router.use(rateLimit({ windowMs: 60000, max: 20, message: { error: 'Price rate limit exceeded' } }));

let priceCache = null;
let priceCacheTs = 0;
const CACHE_TTL = 60000;

router.get('/', async (req, res) => {
  try {
    if (priceCache && Date.now() - priceCacheTs < CACHE_TTL) {
      return res.json(priceCache);
    }

    const ids = [
      'bitcoin','ethereum','binancecoin','solana','matic-network',
      'avalanche-2','tron','arbitrum','optimism','tether','usd-coin',
      'chainlink','shiba-inu','dogecoin','uniswap','aave',
    ].join(',');

    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids, vs_currencies: 'usd', include_24hr_change: true },
      timeout: 8000,
    });

    priceCache   = response.data;
    priceCacheTs = Date.now();
    res.json(priceCache);
  } catch (err) {
    logger.warn(`CoinGecko fetch failed: ${err.message}`);
    // Return cached data if available, even if stale
    if (priceCache) return res.json(priceCache);
    res.status(503).json({ error: 'Price data temporarily unavailable' });
  }
});

module.exports = router;
