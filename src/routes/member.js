'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const rate = require('../lib/rateLimit');
const {
  hashPassword, verifyPassword, generateApiKey, generateWebhookSecret
} = require('../lib/security');
const {
  HttpError, bad, parseWholeRupees, parseRupeesToPaise,
  validateUpi, validateIfsc, validateAccountNumber, cleanText,
  validatePassword, assertPublicWebhookUrl, pageParams
} = require('../lib/validators');
const { requireUser, sameOrigin, setSessionCookie } = require('../middleware/auth');
const { serializeUser, ensureUserApiToken, rupees } = require('../services/users');
const { istDay } = require('../services/ledger');
const linkSvc = require('../services/links');
const creatorWebhooks = require('../services/creatorWebhooks');

const router = express.Router();
router.use(sameOrigin);
router.use(requireUser);

router.get('/dashboard', async (req, res) => {
  const user = await ensureUserApiToken(req.user);
  const s = await settings.getAll();

  const agg = await db.one(
    `SELECT COUNT(*) AS total_links,
            COALESCE(SUM(clicks), 0) AS total_clicks,
            COALESCE(SUM(unlocks), 0) AS total_unlocks,
            COALESCE(SUM(earned_paise), 0) AS total_earned_paise
       FROM links WHERE user_id = $1 AND deleted_at IS NULL`,
    [user.id]
  );

  // Build 14-day IST daily breakdown from link_daily_stats
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400_000);
    days.push(istDay(dt));
  }
  const statRows = await db.many(
    `SELECT day::text AS day, COALESCE(SUM(clicks), 0) AS clicks,
            COALESCE(SUM(unlocks), 0) AS unlocks, COALESCE(SUM(earned_paise), 0) AS earned_paise
       FROM link_daily_stats
      WHERE user_id = $1 AND day >= $2::date
      GROUP BY day ORDER BY day ASC`,
    [user.id, days[0]]
  );
  const byDay = Object.fromEntries(statRows.map((r) => [String(r.day).slice(0, 10), r]));
  const daily = days.map((d) => {
    const r = byDay[d];
    return {
      day: d,
      clicks: r ? Number(r.clicks) : 0,
      unlocks: r ? Number(r.unlocks) : 0,
      earned_rupees: r ? rupees(r.earned_paise) : 0
    };
  });

  const topLinks = await db.many(
    `SELECT * FROM links WHERE user_id = $1 AND deleted_at IS NULL ORDER BY earned_paise DESC, unlocks DESC LIMIT 5`,
    [user.id]
  );

  const recentPayments = await db.many(
    `SELECT p.id, p.amount_paise, p.rzp_payment_id, p.device, p.referrer_host, p.paid_at, l.alias, l.title
       FROM payments p JOIN links l ON l.id = p.link_id
      WHERE p.creator_id = $1 AND p.status = 'paid'
      ORDER BY p.paid_at DESC LIMIT 12`,
    [user.id]
  );

  res.json({
    user: serializeUser(user, { includeApiToken: true }),
    settings: settings.publicView(s),
    summary: {
      total_links: agg.total_links,
      total_clicks: agg.total_clicks,
      total_unlocks: agg.total_unlocks,
      total_earned_rupees: rupees(agg.total_earned_paise),
      effective_cpm_rupees: user.default_price_rupees * 1000
    },
    daily,
    top_links: topLinks.map((l) => linkSvc.serializeLink(l)),
    recent_payments: recentPayments.map((p) => ({
      id: p.id,
      alias: p.alias,
      title: p.title,
      amount_rupees: rupees(p.amount_paise),
      rzp_payment_id: p.rzp_payment_id,
      device: p.device,
      referrer_host: p.referrer_host || 'Direct',
      paid_at: p.paid_at
    }))
  });
});

router.get('/links', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const { total, rows } = await linkSvc.listLinks(req.user.id, {
    q: req.query.q || '',
    ref: req.query.ref || '',
    status: req.query.status || '',
    limit,
    offset
  });
  res.json({ page, limit, total, links: rows.map((l) => linkSvc.serializeLink(l)) });
});

router.post('/links', rate.limit({ name: 'member-create-link', max: 120, windowMs: 60_000, key: (r) => r.user.id }), async (req, res) => {
  const link = await linkSvc.createLink(req.user, req.body || {}, 'dashboard');
  res.status(201).json({ link: linkSvc.serializeLink(link) });
});

router.post('/links/mass', rate.limit({ name: 'member-mass-link', max: 20, windowMs: 60_000, key: (r) => r.user.id }), async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 25) : [];
  if (!urls.length) throw bad('Provide at least one URL.');
  const price = req.body?.price;
  const created = [];
  const errors = [];
  for (const raw of urls) {
    try {
      const link = await linkSvc.createLink(req.user, { url: raw, price }, 'mass');
      created.push(linkSvc.serializeLink(link));
    } catch (err) {
      errors.push({ url: String(raw).slice(0, 120), error: err.message });
    }
  }
  res.status(201).json({ created, errors });
});

router.patch('/links/:alias', async (req, res) => {
  const link = await linkSvc.updateLink(req.user.id, req.params.alias, req.body || {});
  res.json({ link: linkSvc.serializeLink(link) });
});

router.delete('/links/:alias', async (req, res) => {
  await linkSvc.deleteLink(req.user.id, req.params.alias);
  res.json({ ok: true });
});

// ---- Withdrawals & Ledger ----
router.get('/withdrawals', async (req, res) => {
  const s = await settings.getAll();
  const rows = await db.many('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  res.json({
    user: serializeUser(req.user, { includeApiToken: true }),
    settings: settings.publicView(s),
    withdrawals: rows.map((w) => ({
      id: w.id,
      gross_rupees: rupees(w.gross_paise),
      commission_percent: w.commission_bp / 100,
      commission_rupees: rupees(w.commission_paise),
      net_rupees: rupees(w.net_paise),
      method: w.method,
      payout_details: w.payout_details,
      status: w.status,
      utr: w.utr,
      admin_note: w.admin_note,
      created_at: w.created_at,
      processed_at: w.processed_at
    }))
  });
});

router.post('/withdrawals', rate.limit({ name: 'withdraw', max: 10, windowMs: 60 * 60 * 1000, key: (r) => r.user.id }), async (req, res) => {
  const s = await settings.getAll();
  const b = req.body || {};
  const minPaise = s.min_withdrawal_rupees * 100;
  const grossPaise = b.amount_rupees !== undefined && b.amount_rupees !== ''
    ? parseRupeesToPaise(b.amount_rupees, 'Withdrawal amount')
    : Number(req.user.balance_paise);

  if (grossPaise < minPaise) throw bad(`Minimum withdrawal amount is ₹${s.min_withdrawal_rupees}.`);

  const method = b.method || req.user.payout_method || 'upi';
  if (!['upi', 'bank'].includes(method)) throw bad('Payout method must be "upi" or "bank".');

  let payoutDetails;
  if (method === 'upi') {
    const upi = validateUpi(b.upi_id ?? req.user.upi_id);
    payoutDetails = { upi_id: upi };
  } else {
    const name = cleanText(b.bank_account_name ?? req.user.bank_account_name, 120, 'Account holder name');
    if (name.length < 2) throw bad('Bank account holder name is required.');
    const acc = validateAccountNumber(b.bank_account_number ?? req.user.bank_account_number);
    const ifsc = validateIfsc(b.bank_ifsc ?? req.user.bank_ifsc);
    payoutDetails = {
      account_name: name,
      account_number_last4: acc.slice(-4),
      account_number: acc,
      ifsc
    };
  }

  const commissionBp = Math.round(s.withdrawal_commission_percent * 100);
  const commissionPaise = Math.floor((grossPaise * commissionBp) / 10000);
  const netPaise = grossPaise - commissionPaise;

  const result = await db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE users
          SET balance_paise = balance_paise - $2,
              pending_withdrawal_paise = pending_withdrawal_paise + $2,
              updated_at = now()
        WHERE id = $1 AND balance_paise >= $2
        RETURNING *`,
      [req.user.id, grossPaise]
    );
    if (!rows[0]) throw bad('Insufficient wallet balance.');

    const wRes = await t.query(
      `INSERT INTO withdrawals (user_id, gross_paise, commission_bp, commission_paise, net_paise, method, payout_details)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, grossPaise, commissionBp, commissionPaise, netPaise, method, JSON.stringify(payoutDetails)]
    );
    const w = wRes.rows[0];

    await t.query(
      `INSERT INTO wallet_ledger (user_id, entry_type, amount_paise, balance_after_paise, withdrawal_id, note)
       VALUES ($1, 'withdrawal_hold', $2, $3, $4, $5)`,
      [req.user.id, -grossPaise, rows[0].balance_paise, w.id, `Withdrawal #${w.id} (${method.toUpperCase()})`]
    );
    return { user: rows[0], withdrawal: w };
  });

  res.status(201).json({
    user: serializeUser(result.user, { includeApiToken: true }),
    withdrawal: {
      id: result.withdrawal.id,
      gross_rupees: rupees(result.withdrawal.gross_paise),
      commission_percent: result.withdrawal.commission_bp / 100,
      commission_rupees: rupees(result.withdrawal.commission_paise),
      net_rupees: rupees(result.withdrawal.net_paise),
      method: result.withdrawal.method,
      status: result.withdrawal.status,
      created_at: result.withdrawal.created_at
    }
  });
});

router.get('/ledger', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const total = (await db.one('SELECT COUNT(*) AS c FROM wallet_ledger WHERE user_id = $1', [req.user.id])).c;
  const rows = await db.many(
    'SELECT * FROM wallet_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3',
    [req.user.id, limit, offset]
  );
  res.json({
    page, limit, total,
    entries: rows.map((r) => ({
      id: r.id,
      entry_type: r.entry_type,
      amount_rupees: rupees(r.amount_paise),
      balance_after_rupees: rupees(r.balance_after_paise),
      payment_id: r.payment_id,
      withdrawal_id: r.withdrawal_id,
      note: r.note,
      created_at: r.created_at
    }))
  });
});

// ---- Referrals ----
router.get('/referrals', async (req, res) => {
  const s = await settings.getAll();
  const referred = await db.many(
    'SELECT username, created_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC LIMIT 100',
    [req.user.id]
  );
  res.json({
    referral_url: `${config.appUrl}/register?ref=${encodeURIComponent(req.user.username)}`,
    referral_percent: s.referral_percent,
    referral_earned_rupees: rupees(req.user.referral_earned_paise),
    referred_users: referred
  });
});

// ---- API Key & Webhooks ----
router.get('/api-token', async (req, res) => {
  const user = await ensureUserApiToken(req.user);
  res.json({ api_token: user.api_token, user: serializeUser(user, { includeApiToken: true }) });
});

router.post('/api-key/regenerate', async (req, res) => {
  const { key, hash, prefix } = generateApiKey();
  const user = await db.one(
    'UPDATE users SET api_key_hash = $2, api_key_prefix = $3, api_token = $4, updated_at = now() WHERE id = $1 RETURNING *',
    [req.user.id, hash, prefix, key]
  );
  res.json({ api_key: key, api_key_prefix: prefix, user: serializeUser(user, { includeApiToken: true }) });
});

router.patch('/webhook', async (req, res) => {
  const rawUrl = String(req.body?.webhook_url ?? '').trim();
  const url = rawUrl ? await assertPublicWebhookUrl(rawUrl) : '';
  let secret = req.user.webhook_secret;
  if ((url && !secret) || req.body?.rotate_secret) secret = generateWebhookSecret();
  const user = await db.one(
    'UPDATE users SET webhook_url = $2, webhook_secret = $3, updated_at = now() WHERE id = $1 RETURNING *',
    [req.user.id, url, secret]
  );
  res.json({ user: serializeUser(user, { includeApiToken: true }), webhook_secret: req.body?.rotate_secret || (url && !req.user.webhook_secret) ? secret : undefined });
});

router.post('/webhook/reveal-secret', async (req, res) => {
  let secret = req.user.webhook_secret;
  if (!secret) {
    secret = generateWebhookSecret();
    await db.query('UPDATE users SET webhook_secret = $2, updated_at = now() WHERE id = $1', [req.user.id, secret]);
  }
  res.json({ webhook_secret: secret });
});

router.post('/webhook/test', rate.limit({ name: 'webhook-test', max: 10, windowMs: 60_000, key: (r) => r.user.id }), async (req, res) => {
  if (!req.user.webhook_url) throw bad('Save a webhook URL first.');
  const status = await creatorWebhooks.sendTest(req.user);
  res.json({ ok: status >= 200 && status < 300, status });
});

router.get('/webhook/deliveries', async (req, res) => {
  const rows = await db.many(
    'SELECT id, payment_id, event, url, attempts, status, last_status, last_error, created_at, updated_at FROM webhook_deliveries WHERE user_id = $1 ORDER BY id DESC LIMIT 30',
    [req.user.id]
  );
  res.json({ deliveries: rows });
});

// ---- Settings ----
router.patch('/settings', async (req, res) => {
  const s = await settings.getAll();
  const b = req.body || {};
  const sets = [];
  const vals = [req.user.id];
  const add = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };

  if (b.full_name !== undefined) add('full_name', cleanText(b.full_name, 120, 'Full name'));
  if (b.phone !== undefined) add('phone', cleanText(b.phone, 20, 'Phone'));
  if (b.default_price_rupees !== undefined) {
    add('default_price_rupees', parseWholeRupees(b.default_price_rupees, {
      min: s.min_price_rupees, max: s.max_price_rupees, field: 'Default price per link'
    }));
  }
  if (b.payout_method !== undefined) {
    if (!['upi', 'bank'].includes(b.payout_method)) throw bad('payout_method must be "upi" or "bank".');
    add('payout_method', b.payout_method);
  }
  if (b.upi_id !== undefined) add('upi_id', b.upi_id ? validateUpi(b.upi_id) : '');
  if (b.bank_account_name !== undefined) add('bank_account_name', cleanText(b.bank_account_name, 120, 'Account holder name'));
  if (b.bank_account_number !== undefined) add('bank_account_number', b.bank_account_number ? validateAccountNumber(b.bank_account_number) : '');
  if (b.bank_ifsc !== undefined) add('bank_ifsc', b.bank_ifsc ? validateIfsc(b.bank_ifsc) : '');

  let passwordChanged = false;
  if (b.new_password) {
    if (!b.current_password || !(await verifyPassword(b.current_password, req.user.password_hash))) {
      throw bad('Current password is incorrect.');
    }
    add('password_hash', await hashPassword(validatePassword(b.new_password)));
    sets.push('token_version = token_version + 1');
    passwordChanged = true;
  }

  const user = sets.length
    ? await db.one(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals)
    : req.user;

  if (passwordChanged) setSessionCookie(res, user);
  res.json({ user: serializeUser(user, { includeApiToken: true }) });
});

// ---- Support Tickets ----
router.get('/tickets', async (req, res) => {
  const tickets = await db.many('SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ tickets });
});

router.post('/tickets', rate.limit({ name: 'ticket', max: 10, windowMs: 60 * 60 * 1000, key: (r) => r.user.id }), async (req, res) => {
  const b = req.body || {};
  const subject = cleanText(b.subject, 200, 'Subject');
  const category = cleanText(b.category || 'general', 48, 'Category');
  const message = cleanText(b.message, 5000, 'Message');
  if (subject.length < 3 || message.length < 10) throw bad('Subject (min 3 chars) and message (min 10 chars) are required.');
  const ticket = await db.one(
    'INSERT INTO tickets (user_id, subject, category, message) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.user.id, subject, category, message]
  );
  res.status(201).json({ ticket });
});

module.exports = router;

