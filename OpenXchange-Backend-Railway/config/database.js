// ── SQLite Database ───────────────────────────────────────────
// Stores: encrypted API keys, wallet addresses, portfolio snapshots
const path   = require('path');
const logger = require('./logger');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialised — call db.init() first');
  return db;
}

function init() {
  try {
    const Database = require('better-sqlite3');
    const dbPath   = path.join(__dirname, '..', process.env.DB_PATH || 'data/tracker.db');

    // Ensure data dir exists
    const fs = require('fs');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // ── Schema ────────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL,
        address     TEXT NOT NULL,
        chain       TEXT NOT NULL,
        date_added  INTEGER NOT NULL,
        last_synced INTEGER
      );

      CREATE TABLE IF NOT EXISTS exchange_accounts (
        id           TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        exchange     TEXT NOT NULL,
        api_key_enc  TEXT NOT NULL,
        api_sec_enc  TEXT NOT NULL,
        passphrase_enc TEXT,
        date_added   INTEGER NOT NULL,
        last_synced  INTEGER
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp        INTEGER NOT NULL,
        total_value_usd  REAL NOT NULL,
        wallet_value_usd REAL NOT NULL,
        exchange_value_usd REAL NOT NULL,
        breakdown_json   TEXT
      );

      CREATE TABLE IF NOT EXISTS price_alerts (
        id           TEXT PRIMARY KEY,
        coin_id      TEXT NOT NULL,
        symbol       TEXT NOT NULL,
        target_price REAL NOT NULL,
        direction    TEXT NOT NULL CHECK(direction IN ('ABOVE','BELOW')),
        status       TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','TRIGGERED','DISABLED')),
        note         TEXT,
        created_at   INTEGER NOT NULL,
        triggered_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON portfolio_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_alerts_status ON price_alerts(status);

      -- Auth tables
      CREATE TABLE IF NOT EXISTS users (
        id               TEXT PRIMARY KEY,
        username         TEXT UNIQUE NOT NULL,
        password_hash    TEXT NOT NULL,
        role             TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','superuser')),
        totp_secret      TEXT,
        totp_enabled     INTEGER NOT NULL DEFAULT 0,
        email            TEXT,
        full_name        TEXT,
        created_at       INTEGER NOT NULL,
        last_login       INTEGER,
        is_active        INTEGER NOT NULL DEFAULT 1,
        reset_token      TEXT,
        reset_token_exp  INTEGER,
        force_2fa_setup  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        ip_address  TEXT,
        user_agent  TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT,
        action     TEXT NOT NULL,
        detail     TEXT,
        ip_address TEXT,
        timestamp  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id);
    `);

    logger.info('Database initialised');
  } catch (err) {
    logger.error(`Database init failed: ${err.message}`);
    // Non-fatal in dev — use in-memory fallback
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('Running without persistent database (dev mode)');
    } else {
      throw err;
    }
  }
}

module.exports = { init, getDb };
