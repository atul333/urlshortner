'use strict';
const db = require('../db');
const settings = require('../lib/settings');
const razorpay = require('../lib/razorpay');
const { sha256, randomToken } = require('../lib/security');
const { HttpError } = require('../lib/validators');
const { istDay, adjustBalance, audit } = require('./ledger');

const ACCESS_TOKEN_TTL_SECONDS = 120;

/**
 * Double-checks a payment directly with Razorpay's API (never trust the browser):
 * correct order, correct amount, INR, and captured. Captures authorised payments.
 */
async function confirmWithRazorpay(paymentRow, rzpPaymentId) {
  const p = await razorpay.fetchPayment(rzpPaymentId);
  if (p.order_id !== paymentRow.rzp_order_id) throw new HttpError(400, 'Payment does not belong to this order.');
  if (Number(p.amount) !== Number(paymentRow.amount_paise) || p.currency !== 'INR') {
    throw new HttpError(400, 'Payment amount mismatch.');
  }
  if (p.status === 'authorized') {
    const captured = await razorpay.capturePayment(rzpPaymentId, paymentRow.amount_paise);
    if (captured.status !== 'captured') throw new HttpError(409, 'Payment is still processing. Please wait a moment.');
    return captured;
  }
  if (p.status !== 'captured') {
    throw new HttpError(409, p.status === 'failed' ? 'Payment failed. You have not been charged.' : 'Payment is still processing. Please wait a moment.');
  }
  return p;
}

/**
 * Atomically marks an order paid and credits the creator. Idempotent: returns
 * { credited: false } when the payment was already processed.
 */
async function markPaid(paymentRow, rzpPaymentId, via) {
  const s = await settings.getAll();
  const result = await db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE payments
          SET status = 'paid', rzp_payment_id = $2, paid_via = $3, paid_at = now(), updated_at = now(),
              unlock_expires_at = now() + make_interval(hours => $4::int)
        WHERE id = $1 AND status IN ('created', 'failed')
        RETURNING *`,
      [paymentRow.id, rzpPaymentId, via, s.unlock_validity_hours]
    );
    const paid = rows[0];
    if (!paid) return { credited: false };

    const amount = Number(paid.amount_paise);
    await t.query(
      'UPDATE links SET unlocks = unlocks + 1, earned_paise = earned_paise + $2, updated_at = now() WHERE id = $1',
      [paid.link_id, amount]
    );
    await t.query(
      `INSERT INTO link_daily_stats (link_id, user_id, day, unlocks, earned_paise) VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (link_id, day) DO UPDATE SET unlocks = link_daily_stats.unlocks + 1,
         earned_paise = link_daily_stats.earned_paise + EXCLUDED.earned_paise`,
      [paid.link_id, paid.creator_id, istDay(), amount]
    );
    await t.query('UPDATE users SET lifetime_earned_paise = lifetime_earned_paise + $2 WHERE id = $1', [paid.creator_id, amount]);
    await adjustBalance(t, { userId: paid.creator_id, delta: amount, type: 'sale_credit', paymentId: paid.id, note: `Unlock payment ${rzpPaymentId}` });

    // Optional referral bonus (funded by the platform, disabled when 0%).
    if (s.referral_percent > 0) {
      const { rows: cr } = await t.query('SELECT referred_by FROM users WHERE id = $1', [paid.creator_id]);
      const refId = cr[0]?.referred_by;
      const bonus = Math.floor((amount * Math.round(s.referral_percent * 100)) / 10000);
      if (refId && bonus > 0) {
        await t.query('UPDATE users SET referral_earned_paise = referral_earned_paise + $2 WHERE id = $1', [refId, bonus]);
        await adjustBalance(t, { userId: refId, delta: bonus, type: 'referral_credit', paymentId: paid.id, note: 'Referral bonus' });
      }
    }
    return { credited: true, payment: paid };
  });

  if (result.credited) {
    // Fire creator webhook asynchronously (outside the DB transaction).
    require('./creatorWebhooks').queuePaymentEvent(result.payment.id).catch((e) => console.error('[webhook] queue failed', e.message));
  }
  return result;
}

/** Applies a Razorpay refund exactly once (keyed by refund id) and debits the creator. */
async function applyRefund({ paymentId, rzpRefundId, amountPaise, actorId = null }) {
  return db.tx(async (t) => {
    const ins = await t.query(
      `INSERT INTO payment_refunds (payment_id, rzp_refund_id, amount_paise, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (rzp_refund_id) DO NOTHING RETURNING id`,
      [paymentId, rzpRefundId, amountPaise, actorId]
    );
    if (!ins.rows[0]) return { applied: false };
    const { rows } = await t.query(
      `UPDATE payments
          SET refunded_paise = LEAST(amount_paise, refunded_paise + $2),
              status = CASE WHEN refunded_paise + $2 >= amount_paise THEN 'refunded' ELSE status END,
              unlock_expires_at = now(), access_token_hash = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('paid', 'refunded')
        RETURNING *`,
      [paymentId, amountPaise]
    );
    const p = rows[0];
    if (!p) return { applied: false };
    await t.query('UPDATE links SET earned_paise = earned_paise - $2, updated_at = now() WHERE id = $1', [p.link_id, amountPaise]);
    await t.query('UPDATE users SET lifetime_earned_paise = lifetime_earned_paise - $2 WHERE id = $1', [p.creator_id, amountPaise]);
    await adjustBalance(t, { userId: p.creator_id, delta: -amountPaise, type: 'refund_debit', paymentId: p.id, note: `Refund ${rzpRefundId}`, actorId });
    if (actorId) await audit(t, actorId, 'payment.refund', 'payment', p.id, { rzpRefundId, amountPaise });
    return { applied: true, payment: p };
  });
}

/** Finds an active (paid, not expired, opens remaining) purchase of this link for this visitor. */
async function findActivePurchase(linkId, visitorHash) {
  const s = await settings.getAll();
  return db.one(
    `SELECT * FROM payments
      WHERE link_id = $1 AND visitor_hash = $2 AND status = 'paid'
        AND unlock_expires_at > now() AND unlock_opens < $3
      ORDER BY paid_at DESC LIMIT 1`,
    [linkId, visitorHash, s.max_opens_per_payment]
  );
}

/** Issues a fresh single-use, short-lived redirect token bound to the purchase. */
async function issueAccessToken(paymentId) {
  const token = randomToken(32);
  await db.query(
    `UPDATE payments SET access_token_hash = $2, access_token_expires_at = now() + make_interval(secs => $3::int), updated_at = now()
      WHERE id = $1`,
    [paymentId, sha256(token), ACCESS_TOKEN_TTL_SECONDS]
  );
  return `/go/${token}`;
}

/**
 * Consumes a redirect token. Returns destination URL or null.
 * Token must match, not be expired, belong to the same visitor cookie, and the purchase must be active.
 */
async function consumeAccessToken(token, visitorHash) {
  if (!token || token.length < 20 || token.length > 100) return null;
  const s = await settings.getAll();
  return db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE payments p
          SET access_token_hash = NULL, unlock_opens = p.unlock_opens + 1, updated_at = now()
        WHERE p.access_token_hash = $1 AND p.access_token_expires_at > now() AND p.visitor_hash = $2
          AND p.status = 'paid' AND p.unlock_expires_at > now() AND p.unlock_opens < $3
        RETURNING p.link_id`,
      [sha256(token), visitorHash, s.max_opens_per_payment]
    );
    if (!rows[0]) return null;
    const link = await t.query(
      "SELECT destination_url FROM links WHERE id = $1 AND deleted_at IS NULL AND status <> 'blocked'",
      [rows[0].link_id]
    );
    return link.rows[0]?.destination_url || null;
  });
}

module.exports = {
  confirmWithRazorpay,
  markPaid,
  applyRefund,
  findActivePurchase,
  issueAccessToken,
  consumeAccessToken
};

