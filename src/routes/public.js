'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const rate = require('../lib/rateLimit');
const razorpay = require('../lib/razorpay');
const { hmac } = require('../lib/security');
const { bad, cleanText, validateEmail } = require('../lib/validators');
const { sameOrigin } = require('../middleware/auth');
const { rupees } = require('../services/users');

const router = express.Router();
router.use(sameOrigin);

let statsCache = null;
let statsAt = 0;

router.get('/info', async (req, res) => {
  const s = await settings.getAll();
  let stats = null;
  if (s.show_public_stats) {
    if (!statsCache || Date.now() - statsAt > 60_000) {
      const r = await db.one(`
        SELECT (SELECT COUNT(*) FROM users WHERE role = 'creator') AS creators,
               (SELECT COUNT(*) FROM links WHERE deleted_at IS NULL) AS links,
               (SELECT COUNT(*) FROM payments WHERE status = 'paid') AS unlocks,
               (SELECT COALESCE(SUM(net_paise), 0) FROM withdrawals WHERE status = 'paid') AS paid_out_paise`);
      statsCache = { creators: r.creators, links: r.links, unlocks: r.unlocks, paid_out_rupees: rupees(r.paid_out_paise) };
      statsAt = Date.now();
    }
    stats = statsCache;
  }
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ settings: settings.publicView(s), stats, payments_enabled: razorpay.isConfigured() });
});

function maskName(u) {
  if (u.length <= 3) return `${u[0]}**`;
  return `${u.slice(0, 2)}${'*'.repeat(Math.min(4, u.length - 3))}${u.slice(-1)}`;
}

router.get('/payment-proofs', async (req, res) => {
  const rows = await db.many(
    `SELECT w.id, u.username, w.net_paise, w.method, w.utr, w.processed_at
       FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status = 'paid' ORDER BY w.processed_at DESC LIMIT 50`
  );
  res.set('Cache-Control', 'public, max-age=120');
  res.json({
    proofs: rows.map((r) => ({
      id: r.id,
      creator: maskName(r.username),
      amount_rupees: rupees(r.net_paise),
      method: r.method === 'bank' ? 'Bank Transfer' : 'UPI',
      utr: r.utr ? `••••${r.utr.slice(-4)}` : '',
      paid_at: r.processed_at
    }))
  });
});

const REPORT_REASONS = ['phishing', 'malware', 'illegal', 'copyright', 'adult', 'scam', 'other'];

router.post('/report', rate.limit({ name: 'report', max: 10, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const b = req.body || {};
  const alias = String(b.alias || '').trim().replace(/^.*\//, '').slice(0, 40);
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(alias)) throw bad('Please enter the short link or its alias.');
  if (!REPORT_REASONS.includes(b.reason)) throw bad('Please choose a reason.');
  const details = cleanText(b.details, 2000, 'Details');
  const email = b.email ? validateEmail(b.email) : '';
  const link = await db.one('SELECT id FROM links WHERE lower(alias) = lower($1)', [alias]);
  await db.query(
    'INSERT INTO abuse_reports (link_id, alias, reason, details, reporter_email, ip_hash) VALUES ($1, $2, $3, $4, $5, $6)',
    [link?.id || null, alias, b.reason, details, email, hmac(`ip:${req.ip}`)]
  );
  res.status(201).json({ ok: true, message: 'Thank you. Our moderation team will review this link.' });
});

router.post('/contact', rate.limit({ name: 'contact', max: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const b = req.body || {};
  const name = cleanText(b.name, 120, 'Name');
  const email = validateEmail(b.email);
  const subject = cleanText(b.subject, 200, 'Subject');
  const message = cleanText(b.message, 5000, 'Message');
  if (!name || !subject || message.length < 10) throw bad('Please fill in your name, subject and a message (min 10 characters).');
  await db.query(
    'INSERT INTO contact_messages (name, email, subject, message, ip_hash) VALUES ($1, $2, $3, $4, $5)',
    [name, email, subject, message, hmac(`ip:${req.ip}`)]
  );
  res.status(201).json({ ok: true, message: 'Message received. We usually reply within 24-48 hours.' });
});

module.exports = router;

