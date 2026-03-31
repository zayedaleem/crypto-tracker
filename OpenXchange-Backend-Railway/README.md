# OpenXchange Portfolio Tracker — Backend

Node.js/Express backend that handles all exchange API signing, blockchain data fetching,
and encrypted key storage for the OpenXchange Portfolio Tracker.

## Architecture

```
browser (tracker.html)
    │
    │  HTTPS
    ▼
Node.js/Express (server.js :3001)
    ├── /api/prices      → CoinGecko (live prices, cached 60s)
    ├── /api/wallets/:id → Moralis / Blockchair / TronScan
    ├── /api/exchanges/:id → Binance / Bybit / KuCoin / Gate.io / OKX
    │   └── HMAC signing done HERE — API secrets never touch the browser
    ├── /api/nfts/:id    → Moralis NFT API
    └── /api/keys        → SQLite (AES-256 encrypted at rest)
         ├── Wallet addresses
         ├── Exchange API keys (encrypted)
         └── Price alerts
```

## Quick Start

```bash
# 1. Install
cd backend
npm install

# 2. Run interactive setup (generates .env + encryption secret)
npm run setup

# 3. Copy your tracker.html into the public folder
cp /path/to/tracker.html public/

# 4. Start
npm start          # production
npm run dev        # development (auto-reload)

# 5. Open
open http://localhost:3001
```

## API Keys You Need

| Service   | Used For                         | Free Tier | Get at |
|-----------|----------------------------------|-----------|--------|
| Moralis   | EVM balances, Solana, NFTs       | ✅ Yes    | moralis.io |
| CoinGecko | Live prices                      | ✅ Yes    | No key needed |
| Blockchair| Bitcoin data                     | ✅ Yes (limited) | blockchair.com |
| TronScan  | Tron data                        | ✅ Yes    | tronscan.org |

**Exchange API keys** are entered by the user in the app UI — they are encrypted with
AES-256 before being stored in SQLite.

## Environment Variables (.env)

| Variable             | Required | Description |
|----------------------|----------|-------------|
| `PORT`               | No       | Server port (default: 3001) |
| `NODE_ENV`           | No       | `development` or `production` |
| `ENCRYPTION_SECRET`  | **YES**  | 32-char hex — encrypts API keys at rest |
| `ALLOWED_ORIGINS`    | No       | Comma-separated CORS origins |
| `MORALIS_API_KEY`    | No*      | Required for EVM+Solana+NFT data |
| `DB_PATH`            | No       | SQLite file path (default: data/tracker.db) |

*Without Moralis, wallet/NFT data falls back to mock data.

## Deployment Options

### Option A — Same VPS as your website (recommended)
```bash
# Install PM2 (process manager)
npm install -g pm2

# Start with PM2
pm2 start server.js --name tracker-backend
pm2 save
pm2 startup  # auto-start on reboot

# Nginx reverse proxy (add to your site config):
location /api/ {
    proxy_pass http://localhost:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### Option B — Vercel (serverless)
Not ideal for this architecture (SQLite + persistent connections).
Recommend a VPS or Railway instead.

### Option C — Railway / Render / Fly.io
```bash
# Railway
railway init
railway up

# Fly.io
fly launch
fly deploy
```

### Option D — Docker
```bash
docker build -t tracker-backend .
docker run -d -p 3001:3001 \
  -e ENCRYPTION_SECRET=your_secret \
  -e MORALIS_API_KEY=your_key \
  -v $(pwd)/data:/app/data \
  tracker-backend
```

## Updating the Frontend to Use the Backend

The `public/api.js` file replaces the mock `api.js` in `tracker.html`.
To update your tracker.html:

1. Open `tracker.html` in a text editor
2. Find the `// ════ api.js ════` section in the `<script>` block
3. Replace everything between those markers with the contents of `public/api.js`

Or use the included update script:
```bash
node scripts/patch-frontend.js tracker.html
```

## Security Notes

- Exchange API keys are encrypted with AES-256 before SQLite storage
- Keys are decrypted in memory only when making API calls
- API keys are never sent to the browser — only masked versions (••••••••xxxx)
- Rate limiting: 120 req/min global, 20 req/min for price endpoint
- CORS locked to your specified origins
- Helmet.js for security headers
- Input validation on all routes (express-validator)

## Folder Structure

```
backend/
├── server.js              # Main entry point
├── package.json
├── .env.example           # Copy to .env and fill in
├── .env                   # Your secrets (never commit this)
├── data/
│   └── tracker.db         # SQLite database (auto-created)
├── logs/
│   ├── combined.log
│   └── error.log
├── public/
│   ├── tracker.html       # Your frontend (copy here)
│   └── api.js             # Updated frontend API module
├── config/
│   ├── database.js        # SQLite setup
│   ├── encryption.js      # AES-256 helpers
│   └── logger.js          # Winston logger
├── routes/
│   ├── prices.js          # GET /api/prices
│   ├── wallets.js         # GET /api/wallets/:id/*
│   ├── exchanges.js       # GET /api/exchanges/:id/*
│   ├── nfts.js            # GET /api/nfts/:walletId
│   └── keys.js            # CRUD /api/keys/*
├── services/
│   ├── blockchain.js      # Multi-chain data fetching
│   └── exchangeSigning.js # HMAC signing for all 5 exchanges
└── scripts/
    └── setup.js           # Interactive first-time setup
```
