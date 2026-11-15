'use strict';
const express = require('express');
const db = require('../db');
const razorpay = require('../lib/razorpay');
const paymentSvc = require('../services/payments');

const router = express.Router();

/**
 * Razorpay Webhook Endpoint.
 * Must receive the raw JSON body (`express.raw({ type: 'application/json' })`)
 * BEFORE `express.json()` parses it, so HMAC-SHA256 verification matches byte-for-byte.
 */
router.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const sig = req.get('x-razorpay-signature');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  if (!razorpay.verifyWebhookSignature(raw, sig)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const eventId = req.get('x-razorpay-event-id') || `${event.event}:${event.created_at}:${event.payload?.payment?.entity?.id || event.payload?.refund?.entity?.id || ''}`;
  const eventType = String(event.event || '');

  // Deduplicate repeated Razorpay webhook deliveries
  const ins = await db.one(
    'INSERT INTO razorpay_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
    [String(eventId).slice(0, 80), eventType.slice(0, 64)]
  );
  if (!ins) {
    return res.json({ ok: true, duplicate: true });
  }

  if (eventType === 'payment.captured' || eventType === 'order.paid') {
    const p = event.payload?.payment?.entity;
    if (p && p.order_id && p.id && p.currency === 'INR') {
      const row = await db.one('SELECT * FROM payments WHERE rzp_order_id = $1', [p.order_id]);
      if (row && Number(p.amount) === Number(row.amount_paise)) {
        await paymentSvc.markPaid(row, p.id, 'webhook');
      }
    }
  } else if (eventType === 'payment.failed') {
    const p = event.payload?.payment?.entity;
    if (p && p.order_id) {
      await db.query(
        "UPDATE payments SET status = 'failed', updated_at = now() WHERE rzp_order_id = $1 AND status = 'created'",
        [p.order_id]
      );
    }
  } else if (eventType === 'refund.created' || eventType === 'refund.processed') {
    const rf = event.payload?.refund?.entity;
    if (rf && rf.id && rf.payment_id && rf.amount) {
      const row = await db.one('SELECT * FROM payments WHERE rzp_payment_id = $1', [rf.payment_id]);
      if (row) {
        await paymentSvc.applyRefund({
          paymentId: row.id,
          rzpRefundId: rf.id,
          amountPaise: Number(rf.amount),
          actorId: null
        });
      }
    }
  }

  res.json({ ok: true });
});

module.exports = router;

