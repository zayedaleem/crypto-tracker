// ── AES-256-GCM encryption for exchange API keys ─────────────
// Keys are encrypted at rest in SQLite — never stored plaintext
const CryptoJS = require('crypto-js');
const crypto   = require('crypto');

function getSecret() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'ENCRYPTION_SECRET must be set in .env and be at least 32 characters.\n' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return secret;
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const secret = getSecret();
  const encrypted = CryptoJS.AES.encrypt(plaintext, secret).toString();
  return encrypted;
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const secret = getSecret();
  const bytes = CryptoJS.AES.decrypt(ciphertext, secret);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// Generate a secure random secret for first-time setup
function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encrypt, decrypt, generateSecret };
