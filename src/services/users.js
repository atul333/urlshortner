'use strict';

const db = require('../db');
const { generateApiKey } = require('../lib/security');

const rupees = (paise) => Math.round(Number(paise || 0)) / 100;

function maskAccount(num) {
  const s = String(num || '');
  return s.length > 4 ? `${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}` : s;
}

/** Ensure an active user has their own persisted per-account API token. */
async function ensureUserApiToken(user) {
  if (!user || user.api_token) return user;
  const { key, hash, prefix } = generateApiKey();
  return db.one(
    'UPDATE users SET api_key_hash = $2, api_key_prefix = $3, api_token = $4, updated_at = now() WHERE id = $1 RETURNING *',
    [user.id, hash, prefix, key]
  );
}

/** Shape of the logged-in user returned to the browser. Only includes api_token for the account owner when explicitly requested. */
function serializeUser(u, { includeApiToken = false } = {}) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    full_name: u.full_name,
    phone: u.phone,
    role: u.role,
    status: u.status,
    default_price_rupees: u.default_price_rupees,
    balance_rupees: rupees(u.balance_paise),
    pending_withdrawal_rupees: rupees(u.pending_withdrawal_paise),
    total_withdrawn_rupees: rupees(u.total_withdrawn_paise),
    lifetime_earned_rupees: rupees(u.lifetime_earned_paise),
    referral_earned_rupees: rupees(u.referral_earned_paise),
    has_api_key: Boolean(u.api_key_hash),
    api_key_prefix: u.api_key_prefix || null,
    ...(includeApiToken ? { api_token: u.api_token || null } : {}),
    public_key: u.public_key,
    payout_method: u.payout_method,
    upi_id: u.upi_id,
    bank_account_name: u.bank_account_name,
    bank_account_number_masked: maskAccount(u.bank_account_number),
    bank_ifsc: u.bank_ifsc,
    webhook_url: u.webhook_url,
    created_at: u.created_at
  };
}

/** Admin list view */
function serializeUserAdmin(u) {
  return {
    ...serializeUser(u),
    bank_account_number: u.bank_account_number,
    last_login_at: u.last_login_at,
    referred_by: u.referred_by
  };
}

module.exports = { serializeUser, serializeUserAdmin, ensureUserApiToken, rupees, maskAccount };

