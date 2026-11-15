'use strict';
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const rate = require('../lib/rateLimit');
const razorpay = require('../lib/razorpay');
const { sha256, hmac, signPayload, verifyPayload } = require('../lib/security');
const { HttpError, bad } = require('../lib/validators');
const { visitor, sameOrigin } = require('../middleware/auth');
const { istDay } = require('../services/ledger');
const paymentSvc = require('../services/payments');

const router = express.Router();
router.use(sameOrigin);

// Known automated scrapers / CLI tools / link-bypasser bots blocked from the unlock gate.
const BLOCKED_UA_RE = /(curl|wget|python-requests|python-urllib|aiohttp|httpx|scrapy|phantomjs|headlesschrome|slimerjs|go-http-client|java\/|libwww-perl|bypass\.city|bypass\.vip|unshorten)/i;

function assertHumanBrowser(req) {
  const ua = String(req.get('user-agent') || '');
  if (!ua || BLOCKED_UA_RE.test(ua)) {
    throw new HttpError(403, 'Automated access is blocked on protected links.');
  }
  if (config.isProd && /^(node|undici)/i.test(ua)) {
    throw new HttpError(403, 'Automated access is blocked on protected links.');
  }
  return ua;
}

function detectDevice(ua) {
  const l = ua.toLowerCase();
  if (/ipad|tablet/.test(l)) return 'tablet';
  if (/mobile|android|iphone|ipod/.test(l)) return 'mobile';
  return 'desktop';
}

function referrerHost(req) {
  const raw = String(req.get('referer') || req.query.ref_url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.host.toLowerCase() === config.appHost.toLowerCase()) return '';
    return u.hostname.slice(0, 200);
  } catch {
    return '';
  }
}

function setNoCacheHeaders(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  });
}

async function loadActiveLink(alias) {
  const clean = String(alias || '').trim();
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(clean)) throw new HttpError(404, 'Protected link not found.');
  const row = await db.one(
    `SELECT l.*, u.username AS creator_username, u.full_name AS creator_name, u.status AS creator_status
       FROM links l JOIN users u ON u.id = l.user_id
      WHERE lower(l.alias) = lower($1) AND l.deleted_at IS NULL`,
    [clean]
  );
  if (!row || row.creator_status !== 'active') throw new HttpError(404, 'This protected link does not exist.');
  if (row.status === 'blocked') throw new HttpError(403, 'This link has been disabled by moderation.');
  if (row.status === 'paused') throw new HttpError(410, 'This link has been paused by its creator.');
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    throw new HttpError(410, 'This protected link has expired.');
  }
  return row;
}

function verifyGateChallenge(req, alias, gateToken, powSolution) {
  const gate = verifyPayload(gateToken);
  if (!gate) throw new HttpError(403, 'Security session expired. Please refresh the page.');
  if (gate.a !== String(alias).toLowerCase()) throw new HttpError(403, 'Security token mismatch.');
  if (gate.v !== req.visitorHash) throw new HttpError(403, 'Browser cookie check failed. Ensure cookies are enabled and refresh.');
  const uaHash = hmac(`ua:${String(req.get('user-agent') || '')}`);
  if (gate.ua !== uaHash) throw new HttpError(403, 'Browser fingerprint mismatch. Refresh and retry.');

  const sol = String(powSolution ?? '').trim();
  if (!/^\d{1,12}$/.test(sol)) throw new HttpError(403, 'Security verification incomplete.');
  const digest = sha256(`${gate.n}:${sol}`);
  if (!digest.startsWith('0'.repeat(gate.diff || 3))) {
    throw new HttpError(403, 'Security verification failed. Please refresh.');
  }
  return gate;
}

// 1. Load link metadata, check prior unlock, issue anti-bypass gate challenge
router.get('/api/unlock/:alias', visitor, rate.limit({ name: 'unlock-view', max: 60, windowMs: 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  const ua = assertHumanBrowser(req);
  const link = await loadActiveLink(req.params.alias);
  const s = await settings.getAll();

  // Deduplicate click stats per visitor+link per 60 seconds so F5 spam doesn't skew metrics
  const clickKey = `clk:${link.id}:${req.visitorHash}`;
  const bucket = require('../lib/rateLimit');
  let counted = false;
  try {
    bucket.check(clickKey, 1, 60_000);
    counted = true;
  } catch {
    counted = false;
  }

  if (counted) {
    await db.query('UPDATE links SET clicks = clicks + 1 WHERE id = $1', [link.id]);
    await db.query(
      `INSERT INTO link_daily_stats (link_id, user_id, day, clicks) VALUES ($1, $2, $3, 1)
       ON CONFLICT (link_id, day) DO UPDATE SET clicks = link_daily_stats.clicks + 1`,
      [link.id, link.user_id, istDay()]
    );
  }

  const existing = await paymentSvc.findActivePurchase(link.id, req.visitorHash);
  const diff = config.isTest ? 2 : 3;
  const nonce = crypto.randomBytes(12).toString('hex');
  const gateToken = signPayload({
    a: link.alias.toLowerCase(),
    v: req.visitorHash,
    ip: req.ipHash,
    ua: hmac(`ua:${ua}`),
    n: nonce,
    diff
  }, 900);

  // Note: NEVER include destination_url or creator identity in this response!
  res.json({
    site_name: s.site_name,
    alias: link.alias,
    title: link.title || `Protected Resource (${link.alias})`,
    price_rupees: link.price_rupees,
    unlocks: link.unlocks,
    unlock_validity_hours: s.unlock_validity_hours,
    max_opens_per_payment: s.max_opens_per_payment,
    payments_enabled: razorpay.isConfigured(),
    already_unlocked: Boolean(existing),
    opens_remaining: !existing ? 0 : (s.max_opens_per_payment > 0 ? Math.max(0, s.max_opens_per_payment - existing.unlock_opens) : null),
    unlock_expires_at: existing?.unlock_expires_at || null,
    challenge: {
      gate_token: gateToken,
      pow_prefix: nonce,
      pow_difficulty: diff
    }
  });
});

// 2. Re-open previously unlocked link (within validity window & open cap)
router.post('/api/unlock/:alias/reopen', visitor, rate.limit({ name: 'unlock-reopen', max: 20, windowMs: 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  assertHumanBrowser(req);
  const link = await loadActiveLink(req.params.alias);
  verifyGateChallenge(req, link.alias, req.body?.gate_token, req.body?.pow_solution);

  const existing = await paymentSvc.findActivePurchase(link.id, req.visitorHash);
  if (!existing) throw new HttpError(402, 'Payment required to unlock this link.');

  const redirectUrl = await paymentSvc.issueAccessToken(existing.id);
  res.json({ redirect_url: redirectUrl });
});

// 3. Create Razorpay Order (protected by gate_token + PoW + rate limits)
router.post('/api/unlock/:alias/order', visitor, rate.limit({ name: 'unlock-order', max: 15, windowMs: 10 * 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  const ua = assertHumanBrowser(req);
  const link = await loadActiveLink(req.params.alias);
  verifyGateChallenge(req, link.alias, req.body?.gate_token, req.body?.pow_solution);

  const s = await settings.getAll();
  const amountPaise = Number(link.price_rupees) * 100;
  const receipt = `sal_${link.id}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;

  const order = await razorpay.createOrder({
    amountPaise,
    receipt,
    notes: {
      alias: link.alias,
      link_id: String(link.id),
      creator_id: String(link.creator_id || link.user_id)
    }
  });

  await db.query(
    `INSERT INTO payments (link_id, creator_id, amount_paise, rzp_order_id, visitor_hash, ip_hash, user_agent, device, referrer_host)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      link.id,
      link.user_id,
      amountPaise,
      order.id,
      req.visitorHash,
      req.ipHash,
      ua.slice(0, 300),
      detectDevice(ua),
      referrerHost(req)
    ]
  );

  res.json({
    key_id: config.razorpay.keyId,
    order_id: order.id,
    amount_paise: amountPaise,
    amount_rupees: link.price_rupees,
    currency: 'INR',
    site_name: s.site_name,
    title: link.title || `Unlock ${link.alias}`,
    alias: link.alias
  });
});

// 4. Verify Razorpay Checkout payment server-to-server & issue single-use /go/:token
router.post('/api/unlock/:alias/verify', visitor, rate.limit({ name: 'unlock-verify', max: 20, windowMs: 10 * 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  assertHumanBrowser(req);
  const link = await loadActiveLink(req.params.alias);
  const b = req.body || {};
  const orderId = String(b.razorpay_order_id || '').trim();
  const paymentId = String(b.razorpay_payment_id || '').trim();
  const signature = String(b.razorpay_signature || '').trim();
  if (!orderId || !paymentId || !signature) throw bad('Missing payment verification fields.');

  const paymentRow = await db.one(
    'SELECT * FROM payments WHERE rzp_order_id = $1 AND link_id = $2',
    [orderId, link.id]
  );
  if (!paymentRow) throw new HttpError(404, 'Order not found.');
  if (paymentRow.visitor_hash !== req.visitorHash) {
    throw new HttpError(403, 'Order does not belong to this browser session.');
  }

  if (!razorpay.verifyCheckoutSignature(orderId, paymentId, signature)) {
    throw new HttpError(400, 'Invalid Razorpay payment signature.');
  }

  // Server-to-server Razorpay API verification (never trust client alone)
  if (paymentRow.status !== 'paid') {
    await paymentSvc.confirmWithRazorpay(paymentRow, paymentId);
    await paymentSvc.markPaid(paymentRow, paymentId, 'checkout');
  }

  const redirectUrl = await paymentSvc.issueAccessToken(paymentRow.id);
  res.json({
    unlocked: true,
    redirect_url: redirectUrl,
    payment_id: paymentId
  });
});

// 5. Poll order status (for UPI QR / webhook settlement fallback)
router.get('/api/unlock/:alias/status', visitor, rate.limit({ name: 'unlock-status', max: 60, windowMs: 5 * 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  const orderId = String(req.query.order_id || '').trim();
  if (!orderId) throw bad('order_id is required.');
  const link = await loadActiveLink(req.params.alias);
  const paymentRow = await db.one(
    'SELECT * FROM payments WHERE rzp_order_id = $1 AND link_id = $2 AND visitor_hash = $3',
    [orderId, link.id, req.visitorHash]
  );
  if (!paymentRow) throw new HttpError(404, 'Order not found.');
  if (paymentRow.status !== 'paid') {
    return res.json({ status: paymentRow.status, unlocked: false });
  }
  const redirectUrl = await paymentSvc.issueAccessToken(paymentRow.id);
  res.json({ status: 'paid', unlocked: true, redirect_url: redirectUrl });
});

// 6. Atomic single-use redirect endpoint (/go/:token)
router.get('/go/:token', visitor, rate.limit({ name: 'unlock-go', max: 30, windowMs: 60_000 }), async (req, res) => {
  setNoCacheHeaders(res);
  const destinationUrl = await paymentSvc.consumeAccessToken(req.params.token, req.visitorHash);
  if (!destinationUrl) {
    return res.status(403).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Expired — SocialAdLinker</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}
.card{background:#1e293b;border:1px solid rgba(255,255,255,.1);border-radius:16px;max-width:440px;padding:2rem;text-align:center}
a{display:inline-block;margin-top:1rem;padding:.7rem 1.25rem;background:#4f46e5;color:#fff;text-decoration:none;border-radius:8px;font-weight:600}</style></head>
<body><div class="card"><h2>Unlock Link Expired or Invalid</h2>
<p style="color:#94a3b8;font-size:.95rem;line-height:1.5">For anti-bypass security, destination tokens are single-use and bound to the payer's browser session. Return to the short link to re-open or unlock.</p>
<a href="/">Go to SocialAdLinker</a></div></body></html>`);
  }
  res.redirect(302, destinationUrl);
});

module.exports = router;

