'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const razorpay = require('../lib/razorpay');
const {
  HttpError, bad, parseWholeRupees, parseRupeesToPaise, cleanText, pageParams
} = require('../lib/validators');
const { requireAdmin, sameOrigin } = require('../middleware/auth');
const { serializeUserAdmin, rupees } = require('../services/users');
const { istDay, adjustBalance, audit } = require('../services/ledger');
const linkSvc = require('../services/links');
const paymentSvc = require('../services/payments');

const router = express.Router();
router.use(sameOrigin);
router.use(requireAdmin);

router.get('/overview', async (req, res) => {
  const s = await settings.getAll();
  const kpis = await db.one(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'creator') AS creators,
      (SELECT COUNT(*) FROM links WHERE deleted_at IS NULL) AS links,
      (SELECT COUNT(*) FROM payments WHERE status = 'paid') AS paid_unlocks,
      (SELECT COALESCE(SUM(amount_paise - refunded_paise), 0) FROM payments WHERE status IN ('paid','refunded')) AS gross_revenue_paise,
      (SELECT COALESCE(SUM(balance_paise), 0) FROM users) AS wallet_liability_paise,
      (SELECT COALESCE(SUM(pending_withdrawal_paise), 0) FROM users) AS pending_liability_paise,
      (SELECT COUNT(*) FROM withdrawals WHERE status IN ('pending','approved')) AS open_withdrawals,
      (SELECT COALESCE(SUM(net_paise), 0) FROM withdrawals WHERE status IN ('pending','approved')) AS pending_net_paise,
      (SELECT COALESCE(SUM(commission_paise), 0) FROM withdrawals WHERE status = 'paid') AS realized_commission_paise,
      (SELECT COALESCE(SUM(net_paise), 0) FROM withdrawals WHERE status = 'paid') AS completed_payouts_paise,
      (SELECT COUNT(*) FROM tickets WHERE status = 'open') AS open_tickets,
      (SELECT COUNT(*) FROM abuse_reports WHERE status = 'open') AS open_reports
  `);

  const days = [];
  for (let i = 13; i >= 0; i--) days.push(istDay(new Date(Date.now() - i * 86400_000)));
  const trendRows = await db.many(
    `SELECT day::text AS day, COALESCE(SUM(unlocks), 0) AS unlocks, COALESCE(SUM(earned_paise), 0) AS earned_paise
       FROM link_daily_stats WHERE day >= $1::date GROUP BY day ORDER BY day ASC`,
    [days[0]]
  );
  const byDay = Object.fromEntries(trendRows.map((r) => [String(r.day).slice(0, 10), r]));
  const trend = days.map((d) => ({
    day: d,
    unlocks: byDay[d] ? Number(byDay[d].unlocks) : 0,
    revenue_rupees: byDay[d] ? rupees(byDay[d].earned_paise) : 0
  }));

  const recentPayments = await db.many(
    `SELECT p.id, p.amount_paise, p.rzp_payment_id, p.status, p.device, p.paid_at,
            l.alias, u.username AS creator_username
       FROM payments p
       JOIN links l ON l.id = p.link_id
       JOIN users u ON u.id = p.creator_id
      WHERE p.status IN ('paid','refunded')
      ORDER BY p.paid_at DESC LIMIT 12`
  );

  res.json({
    settings: s,
    kpis: {
      creators: kpis.creators,
      links: kpis.links,
      paid_unlocks: kpis.paid_unlocks,
      gross_revenue_rupees: rupees(kpis.gross_revenue_paise),
      wallet_liability_rupees: rupees(kpis.wallet_liability_paise),
      pending_liability_rupees: rupees(kpis.pending_liability_paise),
      open_withdrawals: kpis.open_withdrawals,
      pending_net_rupees: rupees(kpis.pending_net_paise),
      realized_commission_rupees: rupees(kpis.realized_commission_paise),
      completed_payouts_rupees: rupees(kpis.completed_payouts_paise),
      open_tickets: kpis.open_tickets,
      open_reports: kpis.open_reports
    },
    trend,
    recent_payments: recentPayments.map((p) => ({
      id: p.id,
      alias: p.alias,
      creator_username: p.creator_username,
      amount_rupees: rupees(p.amount_paise),
      rzp_payment_id: p.rzp_payment_id,
      status: p.status,
      device: p.device,
      paid_at: p.paid_at
    }))
  });
});

// ---- Withdrawals ----
router.get('/withdrawals', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const status = String(req.query.status || '');
  const where = [];
  const vals = [];
  if (['pending', 'approved', 'paid', 'rejected'].includes(status)) {
    vals.push(status);
    where.push(`w.status = $${vals.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*) AS c FROM withdrawals w ${clause}`, vals)).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT w.*, u.username, u.email
       FROM withdrawals w JOIN users u ON u.id = w.user_id
       ${clause}
      ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.status = 'approved' THEN 1 ELSE 2 END, w.created_at DESC
      LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({
    page, limit, total,
    withdrawals: rows.map((w) => ({
      id: w.id,
      user_id: w.user_id,
      username: w.username,
      email: w.email,
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

router.post('/withdrawals/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.one(
    `UPDATE withdrawals SET status = 'approved', processed_by = $2, updated_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, req.user.id]
  );
  if (!row) throw bad('Withdrawal not found or not in pending state.');
  await audit(db, req.user.id, 'withdrawal.approve', 'withdrawal', id);
  res.json({ ok: true });
});

router.post('/withdrawals/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const utr = cleanText(req.body?.utr, 64, 'UTR / Reference');
  const note = cleanText(req.body?.admin_note || '', 255, 'Admin note');
  if (utr.length < 4) throw bad('Enter a valid UTR or bank transaction reference (min 4 characters).');

  await db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE withdrawals
          SET status = 'paid', utr = $2, admin_note = $3, processed_by = $4, processed_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pending','approved')
        RETURNING *`,
      [id, utr, note, req.user.id]
    );
    const w = rows[0];
    if (!w) throw bad('Withdrawal not found or already processed.');

    await t.query(
      `UPDATE users
          SET pending_withdrawal_paise = pending_withdrawal_paise - $2,
              total_withdrawn_paise = total_withdrawn_paise + $3,
              updated_at = now()
        WHERE id = $1`,
      [w.user_id, w.gross_paise, w.net_paise]
    );
    await audit(t, req.user.id, 'withdrawal.pay', 'withdrawal', id, { utr, net_paise: w.net_paise });
  });
  res.json({ ok: true });
});

router.post('/withdrawals/:id/reject', async (req, res) => {
  const id = Number(req.params.id);
  const note = cleanText(req.body?.admin_note || 'Rejected by admin', 255, 'Reason');

  await db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE withdrawals
          SET status = 'rejected', admin_note = $2, processed_by = $3, processed_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pending','approved')
        RETURNING *`,
      [id, note, req.user.id]
    );
    const w = rows[0];
    if (!w) throw bad('Withdrawal not found or already processed.');

    await t.query(
      'UPDATE users SET pending_withdrawal_paise = pending_withdrawal_paise - $2, updated_at = now() WHERE id = $1',
      [w.user_id, w.gross_paise]
    );
    await adjustBalance(t, {
      userId: w.user_id,
      delta: Number(w.gross_paise),
      type: 'withdrawal_refund',
      withdrawalId: w.id,
      note: `Rejected withdrawal #${w.id}: ${note}`,
      actorId: req.user.id
    });
    await audit(t, req.user.id, 'withdrawal.reject', 'withdrawal', id, { note });
  });
  res.json({ ok: true });
});

// ---- Users ----
router.get('/users', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const q = String(req.query.q || '').trim().toLowerCase();
  const where = q ? 'WHERE lower(u.username) LIKE $1 OR lower(u.email) LIKE $1' : '';
  const vals = q ? [`%${q}%`] : [];
  const total = (await db.one(`SELECT COUNT(*) AS c FROM users u ${where}`, vals)).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT u.*,
            (SELECT COUNT(*) FROM links l WHERE l.user_id = u.id AND l.deleted_at IS NULL) AS links_count,
            (SELECT COALESCE(SUM(unlocks), 0) FROM links l WHERE l.user_id = u.id AND l.deleted_at IS NULL) AS total_unlocks
       FROM users u ${where}
      ORDER BY u.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({
    page, limit, total,
    users: rows.map((u) => ({ ...serializeUserAdmin(u), links_count: u.links_count, total_unlocks: u.total_unlocks }))
  });
});

router.patch('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const s = await settings.getAll();
  const b = req.body || {};

  const updated = await db.tx(async (t) => {
    const u = (await t.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    if (!u) throw new HttpError(404, 'User not found.');
    const sets = [];
    const vals = [id];
    const add = (col, v) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (b.status !== undefined) {
      if (!['active', 'suspended'].includes(b.status)) throw bad('Invalid status.');
      if (id === req.user.id && b.status === 'suspended') throw bad('You cannot suspend your own admin account.');
      add('status', b.status);
      if (b.status === 'suspended') sets.push('token_version = token_version + 1');
    }
    if (b.role !== undefined) {
      if (!['creator', 'admin'].includes(b.role)) throw bad('Invalid role.');
      if (id === req.user.id && b.role !== 'admin') throw bad('You cannot demote yourself.');
      add('role', b.role);
    }
    if (b.default_price_rupees !== undefined) {
      add('default_price_rupees', parseWholeRupees(b.default_price_rupees, {
        min: s.min_price_rupees, max: s.max_price_rupees, field: 'Default price'
      }));
    }
    let userRow = sets.length
      ? (await t.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals)).rows[0]
      : u;

    if (b.adjust_rupees !== undefined && String(b.adjust_rupees).trim() !== '' && Number(b.adjust_rupees) !== 0) {
      const sign = String(b.adjust_rupees).trim().startsWith('-') ? -1 : 1;
      const absPaise = parseRupeesToPaise(String(b.adjust_rupees).trim().replace(/^[-+]/, ''), 'Adjustment');
      const delta = sign * absPaise;
      const note = cleanText(b.adjust_note || 'Admin balance adjustment', 255, 'Adjustment note');
      await adjustBalance(t, { userId: id, delta, type: 'admin_adjustment', note, actorId: req.user.id });
      userRow = (await t.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
    }

    await audit(t, req.user.id, 'user.update', 'user', id, { status: b.status, role: b.role, adjust_rupees: b.adjust_rupees });
    return userRow;
  });

  res.json({ user: serializeUserAdmin(updated) });
});

// ---- Links Moderation ----
router.get('/links', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const q = String(req.query.q || '').trim().toLowerCase();
  const where = ['l.deleted_at IS NULL'];
  const vals = [];
  if (q) {
    vals.push(`%${q}%`);
    where.push(`(lower(l.alias) LIKE $${vals.length} OR lower(l.title) LIKE $${vals.length} OR lower(u.username) LIKE $${vals.length})`);
  }
  const clause = `WHERE ${where.join(' AND ')}`;
  const total = (await db.one(`SELECT COUNT(*) AS c FROM links l JOIN users u ON u.id = l.user_id ${clause}`, vals)).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT l.*, u.username AS creator_username
       FROM links l JOIN users u ON u.id = l.user_id
       ${clause}
      ORDER BY l.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({
    page, limit, total,
    links: rows.map((l) => ({ ...linkSvc.serializeLink(l), creator_username: l.creator_username }))
  });
});

router.patch('/links/:id', async (req, res) => {
  const id = Number(req.params.id);
  const s = await settings.getAll();
  const b = req.body || {};
  const sets = [];
  const vals = [id];
  const add = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (b.status !== undefined) {
    if (!['active', 'paused', 'blocked'].includes(b.status)) throw bad('Invalid link status.');
    add('status', b.status);
  }
  if (b.price_rupees !== undefined) {
    add('price_rupees', parseWholeRupees(b.price_rupees, { min: s.min_price_rupees, max: s.max_price_rupees, field: 'Price' }));
  }
  if (!sets.length) throw bad('Nothing to update.');
  const updated = await db.one(`UPDATE links SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, vals);
  if (!updated) throw new HttpError(404, 'Link not found.');
  await audit(db, req.user.id, 'link.moderate', 'link', id, { status: b.status, price_rupees: b.price_rupees });
  res.json({ link: linkSvc.serializeLink(updated) });
});

// ---- Payments & Refunds ----
router.get('/payments', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const status = String(req.query.status || '');
  const where = [];
  const vals = [];
  if (['created', 'paid', 'failed', 'refunded'].includes(status)) {
    vals.push(status);
    where.push(`p.status = $${vals.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*) AS c FROM payments p ${clause}`, vals)).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT p.*, l.alias, u.username AS creator_username
       FROM payments p JOIN links l ON l.id = p.link_id JOIN users u ON u.id = p.creator_id
       ${clause}
      ORDER BY p.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({
    page, limit, total,
    payments: rows.map((p) => ({
      id: p.id,
      alias: p.alias,
      creator_username: p.creator_username,
      amount_rupees: rupees(p.amount_paise),
      refunded_rupees: rupees(p.refunded_paise),
      rzp_order_id: p.rzp_order_id,
      rzp_payment_id: p.rzp_payment_id,
      status: p.status,
      paid_via: p.paid_via,
      device: p.device,
      paid_at: p.paid_at,
      created_at: p.created_at
    }))
  });
});

router.post('/payments/:id/refund', async (req, res) => {
  const id = Number(req.params.id);
  const p = await db.one('SELECT * FROM payments WHERE id = $1', [id]);
  if (!p) throw new HttpError(404, 'Payment not found.');
  if (p.status !== 'paid' || !p.rzp_payment_id) throw bad('Only paid Razorpay payments can be refunded.');
  const remaining = Number(p.amount_paise) - Number(p.refunded_paise);
  if (remaining <= 0) throw bad('This payment has already been fully refunded.');

  const rf = await razorpay.refundPayment(p.rzp_payment_id, remaining, { reason: 'Admin refund', admin_id: String(req.user.id) });
  await paymentSvc.applyRefund({ paymentId: p.id, rzpRefundId: rf.id, amountPaise: Number(rf.amount || remaining), actorId: req.user.id });
  res.json({ ok: true, refund_id: rf.id });
});

// ---- Settings ----
router.get('/settings', async (req, res) => {
  res.json({ settings: await settings.getAll(true) });
});

router.patch('/settings', async (req, res) => {
  const updated = await settings.update(req.body || {});
  await audit(db, req.user.id, 'settings.update', 'settings', 'global', req.body || {});
  res.json({ settings: updated });
});

// ---- Abuse Reports & Contact Messages ----
router.get('/reports', async (req, res) => {
  const reports = await db.many('SELECT * FROM abuse_reports ORDER BY CASE WHEN status = \'open\' THEN 0 ELSE 1 END, created_at DESC LIMIT 100');
  const contacts = await db.many('SELECT * FROM contact_messages ORDER BY CASE WHEN status = \'open\' THEN 0 ELSE 1 END, created_at DESC LIMIT 100');
  res.json({ reports, contacts });
});

router.patch('/reports/:id', async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status;
  if (!['resolved', 'dismissed', 'open'].includes(status)) throw bad('Invalid status.');
  const r = await db.one('UPDATE abuse_reports SET status = $2 WHERE id = $1 RETURNING *', [id, status]);
  if (!r) throw new HttpError(404, 'Report not found.');
  if (req.body?.block_link && r.link_id) {
    await db.query("UPDATE links SET status = 'blocked', updated_at = now() WHERE id = $1", [r.link_id]);
  }
  await audit(db, req.user.id, 'abuse_report.update', 'abuse_report', id, { status, block_link: Boolean(req.body?.block_link) });
  res.json({ report: r });
});

// ---- Tickets ----
router.get('/tickets', async (req, res) => {
  const tickets = await db.many(
    `SELECT t.*, u.username FROM tickets t JOIN users u ON u.id = t.user_id
      ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.created_at DESC LIMIT 100`
  );
  res.json({ tickets });
});

router.post('/tickets/:id/reply', async (req, res) => {
  const id = Number(req.params.id);
  const reply = cleanText(req.body?.admin_reply, 5000, 'Reply');
  const status = ['open', 'answered', 'closed'].includes(req.body?.status) ? req.body.status : 'answered';
  if (!reply) throw bad('Reply message cannot be empty.');
  const ticket = await db.one(
    'UPDATE tickets SET admin_reply = $2, status = $3, updated_at = now() WHERE id = $1 RETURNING *',
    [id, reply, status]
  );
  if (!ticket) throw new HttpError(404, 'Ticket not found.');
  await audit(db, req.user.id, 'ticket.reply', 'ticket', id, { status });
  res.json({ ticket });
});

// ---- Audit Logs ----
router.get('/audit-logs', async (req, res) => {
  const rows = await db.many(
    `SELECT a.*, u.username AS actor_username
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 100`
  );
  res.json({ logs: rows });
});

module.exports = router;

