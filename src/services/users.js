'use strict';

const rupees = (paise) => Math.round(Number(paise || 0)) / 100;

function maskAccount(num) {
  const s = String(num || '');
  return s.length > 4 ? `${'•'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}` : s;
}

/** Shape of the logged-in user returned to the browser (never includes secrets/hashes). */
function serializeUser(u) {
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

module.exports = { serializeUser, serializeUserAdmin, rupees, maskAccount };

