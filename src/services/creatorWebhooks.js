'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const { assertPublicWebhookUrl } = require('../lib/validators');

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function post(url, secret, event, payload) {
  await assertPublicWebhookUrl(url);
  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SocialAdLinker-Webhooks/1.0',
      'X-SAL-Event': event,
      'X-SAL-Signature': `t=${ts},v1=${sign(secret, ts, body)}`
    },
    body,
    signal: AbortSignal.timeout(8000)
  });
  return res.status;
}

async function attempt(deliveryId) {
  const d = await db.one(
    `SELECT d.*, u.webhook_secret FROM webhook_deliveries d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
    [deliveryId]
  );
  if (!d || d.status !== 'pending') return;
  let status = null;
  let error = '';
  try {
    status = await post(d.url, d.webhook_secret, d.event, d.payload);
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (err) {
    error = String(err.message || err).slice(0, 250);
  }
  const attempts = d.attempts + 1;
  const delivered = !error;
  const finalStatus = delivered ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await db.query(
    `UPDATE webhook_deliveries SET attempts = $2, status = $3, last_status = $4, last_error = $5, updated_at = now() WHERE id = $1`,
    [d.id, attempts, finalStatus, status, error]
  );
  if (finalStatus === 'pending') {
    setTimeout(() => attempt(d.id).catch(() => {}), RETRY_DELAYS_MS[attempts - 1]).unref();
  }
}

function paymentPayload(row) {
  return {
    id: `evt_${row.payment_id}`,
    event: 'payment.paid',
    created_at: new Date().toISOString(),
    data: {
      payment_id: row.payment_id,
      razorpay_payment_id: row.rzp_payment_id,
      amount_rupees: Number(row.amount_paise) / 100,
      currency: 'INR',
      paid_at: row.paid_at,
      link: {
        alias: row.alias,
        short_url: `${config.appUrl}/${row.alias}`,
        title: row.title,
        external_ref: row.external_ref || null,
        price_rupees: row.price_rupees
      }
    }
  };
}

async function queuePaymentEvent(paymentId) {
  const row = await db.one(
    `SELECT p.id AS payment_id, p.rzp_payment_id, p.amount_paise, p.paid_at, p.creator_id,
            l.alias, l.title, l.external_ref, l.price_rupees, u.webhook_url
       FROM payments p JOIN links l ON l.id = p.link_id JOIN users u ON u.id = p.creator_id
      WHERE p.id = $1`,
    [paymentId]
  );
  if (!row || !row.webhook_url) return;
  const d = await db.one(
    `INSERT INTO webhook_deliveries (user_id, payment_id, event, url, payload) VALUES ($1, $2, 'payment.paid', $3, $4) RETURNING id`,
    [row.creator_id, paymentId, row.webhook_url, JSON.stringify(paymentPayload(row))]
  );
  await attempt(d.id);
}

/** Sends a test event synchronously and returns the HTTP status (throws on network/validation error). */
async function sendTest(user) {
  if (!user.webhook_url) throw Object.assign(new Error('Set a webhook URL first.'), { status: 400 });
  const payload = {
    id: `evt_test_${Date.now()}`,
    event: 'webhook.test',
    created_at: new Date().toISOString(),
    data: { message: 'Webhook is configured correctly.', username: user.username }
  };
  return post(user.webhook_url, user.webhook_secret, 'webhook.test', payload);
}

/** Resume deliveries interrupted by a restart. */
async function resumePending() {
  const rows = await db.many(
    `SELECT id FROM webhook_deliveries WHERE status = 'pending' AND updated_at < now() - interval '1 minute' ORDER BY id LIMIT 200`
  );
  for (const r of rows) attempt(r.id).catch(() => {});
}

module.exports = { queuePaymentEvent, sendTest, resumePending, sign };

