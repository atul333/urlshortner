'use strict';
const db = require('../db');

// Typed defaults. Every key the admin can change must be listed here.
const DEFAULTS = {
  site_name: { type: 'string', value: 'SocialAdLinker', max: 60 },
  site_tagline: { type: 'string', value: 'Pay-per-link shortener for creators. No ads, ever.', max: 160 },
  company_name: { type: 'string', value: 'SocialAdLinker', max: 160 },
  support_email: { type: 'string', value: 'support@socialadlinker.com', max: 160 },
  support_phone: { type: 'string', value: '', max: 30 },
  business_address: { type: 'string', value: '', max: 400 },
  grievance_officer: { type: 'string', value: '', max: 160 },
  default_price_rupees: { type: 'int', value: 1, min: 1, max: 10000 },
  min_price_rupees: { type: 'int', value: 1, min: 1, max: 10000 },
  max_price_rupees: { type: 'int', value: 5000, min: 1, max: 100000 },
  withdrawal_commission_percent: { type: 'number', value: 0, min: 0, max: 50 },
  min_withdrawal_rupees: { type: 'int', value: 100, min: 1, max: 1000000 },
  referral_percent: { type: 'number', value: 0, min: 0, max: 50 },
  unlock_validity_hours: { type: 'int', value: 0, min: 0, max: 8760 },
  max_opens_per_payment: { type: 'int', value: 0, min: 0, max: 10000 },
  registrations_open: { type: 'bool', value: true },
  show_public_stats: { type: 'bool', value: true },
  announcement: { type: 'string', value: '', max: 500 }
};

let cache = null;
let cacheAt = 0;
const TTL_MS = 30_000;

function coerce(key, raw) {
  const def = DEFAULTS[key];
  if (!def) return undefined;
  if (raw === undefined || raw === null) return def.value;
  switch (def.type) {
    case 'int': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : def.value;
    }
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def.value;
    }
    case 'bool':
      return raw === true || raw === 'true' || raw === '1' || raw === 1;
    default:
      return String(raw);
  }
}

async function getAll(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const rows = await db.many('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = coerce(key, stored[key]);
  cache = out;
  cacheAt = Date.now();
  return out;
}

/** Validate & persist. Throws Error(message) on invalid values. */
async function update(changes, t) {
  const { bad } = require('./validators');
  const toWrite = {};
  for (const [key, raw] of Object.entries(changes || {})) {
    const def = DEFAULTS[key];
    if (!def) continue;
    if (def.type === 'int') {
      if (!/^\d+$/.test(String(raw).trim())) throw bad(`${key} must be a whole number.`);
      const n = Number(raw);
      if (n < def.min || n > def.max) throw bad(`${key} must be between ${def.min} and ${def.max}.`);
      toWrite[key] = String(n);
    } else if (def.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < def.min || n > def.max) throw bad(`${key} must be between ${def.min} and ${def.max}.`);
      toWrite[key] = String(Math.round(n * 100) / 100);
    } else if (def.type === 'bool') {
      toWrite[key] = raw === true || raw === 'true' || raw === 'on' || raw === '1' ? 'true' : 'false';
    } else {
      const s = String(raw ?? '').trim();
      if (s.length > def.max) throw bad(`${key} must be at most ${def.max} characters.`);
      toWrite[key] = s;
    }
  }
  const current = await getAll(true);
  const merged = { ...current, ...Object.fromEntries(Object.entries(toWrite).map(([k, v]) => [k, coerce(k, v)])) };
  if (merged.min_price_rupees > merged.max_price_rupees) throw bad('Minimum price cannot be greater than maximum price.');
  if (merged.default_price_rupees < merged.min_price_rupees || merged.default_price_rupees > merged.max_price_rupees) {
    throw bad('Default price must be between the minimum and maximum price.');
  }
  const q = t || db;
  for (const [key, value] of Object.entries(toWrite)) {
    await q.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
  }
  cache = null;
  return getAll(true);
}

function publicView(s) {
  return {
    site_name: s.site_name,
    site_tagline: s.site_tagline,
    company_name: s.company_name,
    support_email: s.support_email,
    support_phone: s.support_phone,
    business_address: s.business_address,
    grievance_officer: s.grievance_officer,
    default_price_rupees: s.default_price_rupees,
    min_price_rupees: s.min_price_rupees,
    max_price_rupees: s.max_price_rupees,
    withdrawal_commission_percent: s.withdrawal_commission_percent,
    min_withdrawal_rupees: s.min_withdrawal_rupees,
    referral_percent: s.referral_percent,
    unlock_validity_hours: s.unlock_validity_hours,
    max_opens_per_payment: s.max_opens_per_payment,
    registrations_open: s.registrations_open,
    show_public_stats: s.show_public_stats,
    announcement: s.announcement
  };
}

module.exports = { DEFAULTS, getAll, update, publicView, clearCache: () => { cache = null; } };

