'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const rate = require('../lib/rateLimit');
const { HttpError, bad, pageParams } = require('../lib/validators');
const { requireApiKey } = require('../middleware/auth');
const { rupees } = require('../services/users');
const linkSvc = require('../services/links');

// ---- REST API v1 (/api/v1/*) for Telegram bots, apps, and websites ----
const v1 = express.Router();
v1.use(requireApiKey);
v1.use(rate.limit({ name: 'api-v1', max: 120, windowMs: 60_000, key: (r) => r.apiUser.id }));

v1.get('/account', async (req, res) => {
  const u = req.apiUser;
  res.json({
    username: u.username,
    default_price_rupees: u.default_price_rupees,
    balance_rupees: rupees(u.balance_paise),
    lifetime_earned_rupees: rupees(u.lifetime_earned_paise),
    webhook_url: u.webhook_url || null
  });
});

v1.post('/links', async (req, res) => {
  const link = await linkSvc.createLink(req.apiUser, req.body || {}, 'api');
  res.status(201).json({ link: linkSvc.serializeLink(link) });
});

v1.get('/links', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const { total, rows } = await linkSvc.listLinks(req.apiUser.id, {
    q: req.query.q || '',
    ref: req.query.ref || '',
    status: req.query.status || '',
    limit,
    offset
  });
  res.json({ page, limit, total, links: rows.map((l) => linkSvc.serializeLink(l)) });
});

v1.get('/links/:alias', async (req, res) => {
  const link = await db.one(
    'SELECT * FROM links WHERE user_id = $1 AND lower(alias) = lower($2) AND deleted_at IS NULL',
    [req.apiUser.id, String(req.params.alias)]
  );
  if (!link) throw new HttpError(404, 'Link not found.');
  res.json({ link: linkSvc.serializeLink(link) });
});

v1.patch('/links/:alias', async (req, res) => {
  const link = await linkSvc.updateLink(req.apiUser.id, req.params.alias, req.body || {});
  res.json({ link: linkSvc.serializeLink(link) });
});

v1.delete('/links/:alias', async (req, res) => {
  await linkSvc.deleteLink(req.apiUser.id, req.params.alias);
  res.json({ ok: true });
});

v1.get('/payments', async (req, res) => {
  const { page, limit, offset } = pageParams(req.query, 100);
  const where = ['p.creator_id = $1', "p.status = 'paid'"];
  const vals = [req.apiUser.id];
  if (req.query.alias) {
    vals.push(String(req.query.alias));
    where.push(`lower(l.alias) = lower($${vals.length})`);
  }
  if (req.query.ref) {
    vals.push(String(req.query.ref));
    where.push(`l.external_ref = $${vals.length}`);
  }
  const total = (await db.one(
    `SELECT COUNT(*) AS c FROM payments p JOIN links l ON l.id = p.link_id WHERE ${where.join(' AND ')}`, vals
  )).c;
  vals.push(limit, offset);
  const rows = await db.many(
    `SELECT p.id, p.amount_paise, p.rzp_order_id, p.rzp_payment_id, p.paid_at, l.alias, l.external_ref
       FROM payments p JOIN links l ON l.id = p.link_id
      WHERE ${where.join(' AND ')} ORDER BY p.paid_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals
  );
  res.json({
    page, limit, total,
    payments: rows.map((p) => ({
      payment_id: p.id,
      alias: p.alias,
      external_ref: p.external_ref || null,
      amount_rupees: rupees(p.amount_paise),
      razorpay_order_id: p.rzp_order_id,
      razorpay_payment_id: p.rzp_payment_id,
      paid_at: p.paid_at
    }))
  });
});

// ---- Legacy / Simple Drop-In Endpoints (/api & /st & /js/full-page-script.js) ----
const legacy = express.Router();

// Drop-in shortener: GET/POST /api?api=sal_sk_...&url=...&price=1&alias=...&format=json|text
async function simpleShorten(req, res) {
  const p = { ...req.query, ...req.body };
  const format = String(p.format || 'json').toLowerCase();
  try {
    const link = await linkSvc.createLink(req.apiUser, {
      url: p.url,
      price: p.price ?? p.cpm_price ?? p.cost,
      alias: p.alias,
      title: p.title,
      ref: p.ref
    }, 'api');
    const shortUrl = `${config.appUrl}/${link.alias}`;
    if (format === 'text') return res.type('text/plain').send(shortUrl);
    return res.json({
      status: 'success',
      shortenedUrl: shortUrl,
      short_url: shortUrl,
      alias: link.alias,
      price_rupees: link.price_rupees,
      effective_cpm_rupees: link.price_rupees * 1000
    });
  } catch (err) {
    const code = err.status || 400;
    if (format === 'text') return res.status(code).type('text/plain').send('');
    return res.status(code).json({ status: 'error', message: err.message });
  }
}

legacy.all('/api', requireApiKey, rate.limit({ name: 'api-legacy', max: 120, windowMs: 60_000, key: (r) => r.apiUser.id }), simpleShorten);

// Quick Link endpoint: /st?pk=sal_pk_...&url=...&price=1 (also supports api=sal_sk_...)
legacy.get('/st', rate.limit({ name: 'quick-link', max: 60, windowMs: 60_000 }), async (req, res) => {
  const pk = String(req.query.pk || '').trim();
  const sk = String(req.query.api || '').trim();
  let user = null;
  if (pk.startsWith('sal_pk_')) {
    user = await db.one("SELECT * FROM users WHERE public_key = $1 AND status = 'active'", [pk]);
  } else if (sk.startsWith('sal_sk_')) {
    const { sha256 } = require('../lib/security');
    user = await db.one("SELECT * FROM users WHERE api_key_hash = $1 AND status = 'active'", [sha256(sk)]);
  }
  if (!user) throw new HttpError(401, 'Missing or invalid public key (pk=sal_pk_...).');
  const link = await linkSvc.findOrCreateQuickLink(user, req.query.url, req.query.price);
  res.redirect(302, `/${link.alias}`);
});

// Safe Full-Page Script using creator's public_key (sal_pk_...) so no secret key leaks in HTML!
legacy.get('/js/full-page-script.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/javascript').send(`(function () {
  var pk = window.sal_public_key || '';
  if (!pk) return;
  var price = window.sal_price_rupees || '';
  var includeDomains = window.sal_include_domains || [];
  var excludeDomains = window.sal_exclude_domains || [];
  var origin = ${JSON.stringify(config.appUrl)};
  function wrapLinks() {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.dataset.salWrapped) continue;
      try {
        var u = new URL(a.href, window.location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (u.origin === window.location.origin || u.origin === origin) continue;
        if (includeDomains.length && includeDomains.indexOf(u.hostname) === -1) continue;
        if (excludeDomains.indexOf(u.hostname) !== -1) continue;
        var q = origin + '/st?pk=' + encodeURIComponent(pk) + '&url=' + encodeURIComponent(u.toString());
        if (price) q += '&price=' + encodeURIComponent(price);
        a.href = q;
        a.dataset.salWrapped = '1';
      } catch (e) {}
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wrapLinks);
  else wrapLinks();
})();`);
});

module.exports = { v1, legacy };

