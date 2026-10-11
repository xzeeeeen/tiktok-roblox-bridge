import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const num = (key, def) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
};
const bool = (key, def) => {
  const raw = (process.env[key] ?? '').toString().trim().toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
};

function secret(envKey, name) {
  const fromEnv = (process.env[envKey] || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(DATA_DIR, 'secrets.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* belum ada */ }
  if (!store[name]) {
    store[name] = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  }
  return store[name];
}

export const config = {
  PORT: num('PORT', 3000),
  HOST: process.env.HOST || '0.0.0.0',
  ADMIN_API_KEY: secret('ADMIN_API_KEY', 'admin'),
  ROBLOX_API_KEY: secret('ROBLOX_API_KEY', 'roblox'),
  TIKTOK_USERNAME: (process.env.TIKTOK_USERNAME || '').replace(/^@/, '').trim(),
  TIKTOK_SIGN_API_KEY: (process.env.TIKTOK_SIGN_API_KEY || '').trim(),
  TIKTOK_SESSION_ID: (process.env.TIKTOK_SESSION_ID || '').trim(),
  TIKTOK_WAIT_FOR_LIVE: bool('TIKTOK_WAIT_FOR_LIVE', true),
  MAX_QUEUE_SIZE: num('MAX_QUEUE_SIZE', 300),
  CLAIM_LEASE_SECONDS: num('CLAIM_LEASE_SECONDS', 30),
  EVENT_TTL_SECONDS: num('EVENT_TTL_SECONDS', 180),
  MAX_ATTEMPTS: num('MAX_ATTEMPTS', 3),
  RATE_LIMIT_PER_MINUTE: num('RATE_LIMIT_PER_MINUTE', 240),
};
