// ── /api/nfts ─────────────────────────────────────────────────
const router = require('express').Router();
const axios  = require('axios');
const { param, validationResult } = require('express-validator');
const { getDb } = require('../config/database');
const logger = require('../config/logger');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

const EVM_CHAINS  = ['ETHEREUM','BSC','POLYGON','ARBITRUM','OPTIMISM','BASE','AVALANCHE'];
const CHAIN_IDS   = { ETHEREUM:'0x1',BSC:'0x38',POLYGON:'0x89',ARBITRUM:'0xa4b1',OPTIMISM:'0xa',BASE:'0x2105',AVALANCHE:'0xa86a' };

async function fetchEvmNFTs(address, chain) {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return [];
  try {
    const res = await axios.get(
      `https://deep-index.moralis.io/api/v2.2/${address}/nft`,
      {
        headers: { 'X-API-Key': key },
        params:  { chain: CHAIN_IDS[chain], limit: 50, format: 'decimal' },
        timeout: 12000,
      }
    );
    return (res.data?.result || []).map(n => {
      let meta = {};
      try { meta = JSON.parse(n.metadata || '{}'); } catch {}
      return {
        tokenId:    n.token_id,
        contract:   n.token_address,
        name:       meta.name || n.name || `#${n.token_id}`,
        collection: n.name || 'Unknown Collection',
        image:      meta.image || meta.image_url || null,
        standard:   n.contract_type || 'ERC-721',
      };
    });
  } catch (err) {
    logger.warn(`NFT fetch failed for ${chain}:${address.slice(0,8)}: ${err.message}`);
    return [];
  }
}

async function fetchSolanaNFTs(address) {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return [];
  try {
    const res = await axios.get(
      `https://solana-gateway.moralis.io/account/mainnet/${address}/nft`,
      { headers: { 'X-API-Key': key }, timeout: 12000 }
    );
    return (res.data || []).map(n => ({
      tokenId:    n.mint,
      contract:   n.mint,
      name:       n.name || n.symbol || 'Solana NFT',
      collection: n.symbol || 'Solana Collection',
      image:      null,
      standard:   'SPL',
    }));
  } catch (err) {
    logger.warn(`Solana NFT fetch failed: ${err.message}`);
    return [];
  }
}

// GET /api/nfts/:walletId
router.get('/:walletId', param('walletId').isString(), validate, async (req, res) => {
  try {
    const wallet = getDb().prepare('SELECT * FROM wallets WHERE id = ?').get(req.params.walletId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    let nfts = [];
    if (wallet.chain === 'SOLANA') {
      nfts = await fetchSolanaNFTs(wallet.address);
    } else if (EVM_CHAINS.includes(wallet.chain)) {
      nfts = await fetchEvmNFTs(wallet.address, wallet.chain);
    }

    res.json({ walletId: wallet.id, chain: wallet.chain, nfts });
  } catch (err) {
    logger.error(`NFT route error: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
