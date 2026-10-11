import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'mappings.json');

export const DEFAULT_MAPPINGS = {
  comment: {
    enabled: true,
    mode: 'both',            // mention | command | both
    command: '!spawn',
    allowBareUsername: false,
    perRobloxUserCooldownSeconds: 30,
    perTikTokUserCooldownSeconds: 10,
  },
  // Kunci = nama gift TikTok (tidak peka huruf besar/kecil)
  gifts: {
    'Rose':          { effect: 'rose_rain' },
    'Finger Heart':  { effect: 'hearts' },
    'Heart Me':      { effect: 'hearts' },
    'TikTok':        { effect: 'sparkle' },
    'GG':            { effect: 'sparkle' },
    'Doughnut':      { effect: 'sparkle' },
    'Confetti':      { effect: 'confetti' },
    'Galaxy':        { effect: 'fireworks' },
    'Lion':          { effect: 'mega' },
    'Universe':      { effect: 'mega' },
  },
  // Cadangan jika gift tidak ada di daftar di atas (berdasarkan total diamond)
  giftTiers: [
    { minDiamonds: 1,    effect: 'sparkle' },
    { minDiamonds: 50,   effect: 'confetti' },
    { minDiamonds: 300,  effect: 'fireworks' },
    { minDiamonds: 1000, effect: 'mega' },
  ],
  follow: { enabled: true, effect: 'welcome' },
  share:  { enabled: true, effect: 'sparkle' },
  likeMilestone: { enabled: true, every: 200, effect: 'hearts' },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

let current = structuredClone(DEFAULT_MAPPINGS);
try { current = merge(DEFAULT_MAPPINGS, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { /* pakai default */ }

export function getMappings() { return current; }

export function validateMappings(m) {
  if (!isObj(m)) throw new Error('Mapping harus berupa objek JSON.');
  if (m.gifts && !isObj(m.gifts)) throw new Error('"gifts" harus berupa objek.');
  for (const [name, rule] of Object.entries(m.gifts || {})) {
    if (!isObj(rule) || typeof rule.effect !== 'string' || !rule.effect) {
      throw new Error(`Gift "${name}" harus punya field "effect" (string).`);
    }
  }
  if (m.giftTiers && !Array.isArray(m.giftTiers)) throw new Error('"giftTiers" harus berupa array.');
  for (const t of m.giftTiers || []) {
    if (typeof t.minDiamonds !== 'number' || typeof t.effect !== 'string') {
      throw new Error('Setiap giftTiers wajib punya minDiamonds (angka) dan effect (string).');
    }
  }
}

export function setMappings(next) {
  validateMappings(next);
  // Dashboard mengirim dokumen utuh; field yang hilang kembali ke default
  current = merge(DEFAULT_MAPPINGS, next);
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return current;
}

export function resolveGiftEffect(giftName, totalDiamonds) {
  const m = current;
  const key = Object.keys(m.gifts).find((k) => k.toLowerCase() === String(giftName || '').toLowerCase());
  if (key) return { effect: m.gifts[key].effect, params: m.gifts[key].params || {}, matched: key };
  const tiers = [...(m.giftTiers || [])].sort((a, b) => b.minDiamonds - a.minDiamonds);
  const tier = tiers.find((t) => totalDiamonds >= t.minDiamonds);
  return tier ? { effect: tier.effect, params: tier.params || {}, matched: `tier>=${tier.minDiamonds}` } : null;
}
