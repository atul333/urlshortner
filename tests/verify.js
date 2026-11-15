'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

// Configure isolated test environment BEFORE requiring server/config
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.APP_URL = 'http://127.0.0.1:0';
process.env.DATABASE_URL = 'pglite:memory';
process.env.SESSION_SECRET = 'test_session_secret_0123456789abcdefghijklmnopqrstuvwxyz_64chars';
process.env.RAZORPAY_KEY_ID = 'rzp_test_socialadlinker';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_1234567890';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test_rzp_1234567890';
process.env.ALLOW_PRIVATE_WEBHOOKS = 'true';
process.env.ADMIN_INIT_USERNAME = 'adminroot';
process.env.ADMIN_INIT_EMAIL = 'admin@socialadlinker.com';
process.env.ADMIN_INIT_PASSWORD = 'AdminPass123';

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function solvePow(prefix, diff) {
  const target = '0'.repeat(diff);
  for (let i = 0; i < 500000; i++) {
    if (sha256(`${prefix}:${i}`).startsWith(target)) return String(i);
  }
  throw new Error('Failed to solve PoW');
}

// Simple cookie jar client
class Client {
  constructor(baseUrl, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0') {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.ua = ua;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  captureCookies(res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (v) this.cookies.set(k, v);
        else this.cookies.delete(k);
      }
    }
  }

  async req(path, opts = {}) {
    const headers = { 'User-Agent': this.ua, ...(opts.headers || {}) };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch(this.baseUrl + path, {
      redirect: 'manual',
      ...opts,
      headers
    });
    this.captureCookies(res);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, headers: res.headers, data };
  }
}

function startMockRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let seq = 1;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && req.url === '/v1/orders') {
        const id = `order_mock_${seq++}`;
        const order = { id, amount: json.amount, currency: json.currency, receipt: json.receipt, status: 'created' };
        orders.set(id, order);
        res.end(JSON.stringify(order));
        return;
      }

      const getPay = req.url.match(/^\/v1\/payments\/([^/]+)$/);
      if (req.method === 'GET' && getPay) {
        const payId = decodeURIComponent(getPay[1]);
        const p = payments.get(payId);
        if (!p) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: { description: 'Payment not found' } }));
          return;
        }
        res.end(JSON.stringify(p));
        return;
      }

      const refPay = req.url.match(/^\/v1\/payments\/([^/]+)\/refund$/);
      if (req.method === 'POST' && refPay) {
        const payId = decodeURIComponent(refPay[1]);
        const p = payments.get(payId);
        const rfId = `rfnd_mock_${seq++}`;
        res.end(JSON.stringify({ id: rfId, payment_id: payId, amount: json.amount || p?.amount || 0, status: 'processed' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { description: 'Unknown mock endpoint' } }));
    });
  });

  return {
    server,
    seedCapturedPayment(orderId, payId) {
      const ord = orders.get(orderId);
      assert.ok(ord, `Order ${orderId} must exist in mock Razorpay`);
      payments.set(payId, { id: payId, order_id: orderId, amount: ord.amount, currency: 'INR', status: 'captured' });
    }
  };
}

function startCreatorWebhookServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({
        event: req.headers['x-sal-event'],
        signature: req.headers['x-sal-signature'],
        raw,
        body: JSON.parse(raw)
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, received };
}

async function run() {
  const mockRzp = startMockRazorpay();
  await new Promise((r) => mockRzp.server.listen(0, '127.0.0.1', r));
  const rzpPort = mockRzp.server.address().port;
  process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${rzpPort}/v1`;

  const creatorHook = startCreatorWebhookServer();
  await new Promise((r) => creatorHook.server.listen(0, '127.0.0.1', r));
  const hookPort = creatorHook.server.address().port;

  // Load config & server AFTER RAZORPAY_API_BASE is set
  const config = require('../src/config');
  const db = require('../src/db');
  const { createApp, bootstrapInitialAdmin } = require('../src/server');
  const creatorWebhooks = require('../src/services/creatorWebhooks');

  await db.migrate();
  await bootstrapInitialAdmin();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  config.appUrl = baseUrl;
  config.appHost = `127.0.0.1:${port}`;

  try {
    // 1. Health & Public pages
    const anon = new Client(baseUrl);
    assert.equal((await anon.req('/healthz')).status, 200);
    for (const p of ['/', '/pricing', '/developers', '/payment-proof', '/terms', '/privacy', '/refund-policy', '/delivery-policy', '/contact', '/report']) {
      assert.equal((await anon.req(p)).status, 200, `Expected 200 for ${p}`);
    }
    const pubInfo = await anon.req('/api/public/info');
    assert.equal(pubInfo.status, 200);
    assert.equal(pubInfo.data.settings.site_name, 'SocialAdLinker');
    console.log('✓ Health, compliance pages & public info verified');

    // 2. Creator registration & auth
    const creator = new Client(baseUrl);
    const badReg = await creator.req('/api/auth/register', {
      method: 'POST',
      json: { username: 'botmaker', email: 'bot@example.com', password: 'Password123', accept_terms: false }
    });
    assert.equal(badReg.status, 400, 'Must require Terms acceptance');

    const reg = await creator.req('/api/auth/register', {
      method: 'POST',
      json: { full_name: 'Bot Maker', username: 'botmaker', email: 'bot@example.com', password: 'Password123', accept_terms: true }
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.user.default_price_rupees, 1);
    const initialApiToken = reg.data.user.api_token;
    assert.ok(initialApiToken && initialApiToken.startsWith('sal_sk_'), 'Registration must auto-generate a personal API token');

    const tokenRes = await creator.req('/api/member/api-token');
    assert.equal(tokenRes.status, 200);
    assert.equal(tokenRes.data.api_token, initialApiToken);

    // Auto-generated personal token must work immediately on GET /api (JSON + CustomAlias + domain-only URL)
    const legacyJson = await anon.req(`/api?api=${initialApiToken}&url=yourdestinationlink.com&alias=CustomAlias`);
    assert.equal(legacyJson.status, 200);
    assert.equal(legacyJson.data.status, 'success');
    assert.equal(legacyJson.data.shortenedUrl, `${baseUrl}/CustomAlias`);

    // On &format=text errors, output nothing
    const legacyTextErr = await anon.req(`/api?api=${initialApiToken}&url=notadomain&format=text`);
    assert.equal(legacyTextErr.status, 400);
    assert.equal(legacyTextErr.data, '');

    // 3. Whole-number price enforcement & Developer API key + Telegram Bot workflow (regeneration rotates token)
    const keyRes = await creator.req('/api/member/api-key/regenerate', { method: 'POST' });
    assert.equal(keyRes.status, 200);
    const apiKey = keyRes.data.api_key;
    assert.ok(apiKey.startsWith('sal_sk_'));
    assert.notEqual(apiKey, initialApiToken, 'Regenerated API token must differ from initial token');
    assert.equal(keyRes.data.user.api_token, apiKey);

    const oldTokenFail = await anon.req(`/api?api=${initialApiToken}&url=https://example.com/old`);
    assert.equal(oldTokenFail.status, 401);

    // Reject decimal prices across dashboard & API v1 & legacy /api
    for (const badP of [1.1, 1.5, 0, -3, '2.5', 'abc']) {
      const r1 = await creator.req('/api/member/links', { method: 'POST', json: { url: 'https://example.com/a', price: badP } });
      assert.equal(r1.status, 400, `Dashboard must reject price ${badP}`);
      const r2 = await anon.req('/api/v1/links', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        json: { url: 'https://example.com/a', price: badP }
      });
      assert.equal(r2.status, 400, `API v1 must reject price ${badP}`);
    }

    // Create link via API v1 at ₹2 with external_ref
    const apiLinkRes = await anon.req('/api/v1/links', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      json: { url: 'https://example.com/secret-course.pdf', price: 2, title: 'Telegram PDF Pack', ref: 'tg_9901' }
    });
    assert.equal(apiLinkRes.status, 201);
    const alias = apiLinkRes.data.link.alias;
    assert.equal(apiLinkRes.data.link.price_rupees, 2);

    // Legacy /api text endpoint & /st Quick Link
    const legacyText = await anon.req(`/api?api=${apiKey}&url=https://example.com/file2&price=3&format=text`);
    assert.equal(legacyText.status, 200);
    assert.ok(legacyText.data.startsWith(baseUrl));

    const pk = reg.data.user.public_key;
    const stRes = await anon.req(`/st?pk=${pk}&url=https://example.com/quick&price=1`);
    assert.equal(stRes.status, 302);
    console.log('✓ Whole-number ₹ pricing, API v1, legacy /api & Quick Link /st verified');

    // Configure Creator Webhook
    const whSet = await creator.req('/api/member/webhook', {
      method: 'PATCH',
      json: { webhook_url: `http://127.0.0.1:${hookPort}/hook` }
    });
    assert.equal(whSet.status, 200);
    const whSecret = whSet.data.webhook_secret;
    assert.ok(whSecret.startsWith('whsec_'));

    // 4. ANTI-BYPASS TESTS
    // 4a. Blocked UA scraper rejected
    const curlBot = new Client(baseUrl, 'curl/8.5.0');
    const curlAttempt = await curlBot.req(`/api/unlock/${alias}`);
    assert.equal(curlAttempt.status, 403, 'curl scraper must be blocked');

    // 4b. Visitor loads gate -> destination_url NEVER exposed!
    const visitor = new Client(baseUrl);
    const gate = await visitor.req(`/api/unlock/${alias}`);
    assert.equal(gate.status, 200);
    assert.equal(JSON.stringify(gate.data).includes('secret-course.pdf'), false, 'Destination URL must NEVER be leaked before payment!');
    assert.equal(gate.data.price_rupees, 2);

    // 4c. Order creation fails without valid gate_token or PoW
    const noChallenge = await visitor.req(`/api/unlock/${alias}/order`, {
      method: 'POST',
      json: { gate_token: gate.data.challenge.gate_token, pow_solution: '99999999' }
    });
    assert.equal(noChallenge.status, 403, 'Wrong PoW solution must be blocked');

    // Solve PoW properly and create Razorpay order
    const powSol = solvePow(gate.data.challenge.pow_prefix, gate.data.challenge.pow_difficulty);
    const ordRes = await visitor.req(`/api/unlock/${alias}/order`, {
      method: 'POST',
      json: { gate_token: gate.data.challenge.gate_token, pow_solution: powSol }
    });
    assert.equal(ordRes.status, 200);
    const orderId = ordRes.data.order_id;
    assert.equal(ordRes.data.amount_paise, 200);

    // 4d. Forged Razorpay signature rejected
    const fakePayId = 'pay_mock_1001';
    mockRzp.seedCapturedPayment(orderId, fakePayId);
    const badSigRes = await visitor.req(`/api/unlock/${alias}/verify`, {
      method: 'POST',
      json: { razorpay_order_id: orderId, razorpay_payment_id: fakePayId, razorpay_signature: 'forged_sig' }
    });
    assert.equal(badSigRes.status, 400, 'Forged Razorpay signature must be rejected');

    // 4e. Another browser session cannot hijack/verify someone else's order
    const attacker = new Client(baseUrl);
    await attacker.req(`/api/unlock/${alias}`); // gets different sal_vid cookie
    const validSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${fakePayId}`).digest('hex');
    const hijackRes = await attacker.req(`/api/unlock/${alias}/verify`, {
      method: 'POST',
      json: { razorpay_order_id: orderId, razorpay_payment_id: fakePayId, razorpay_signature: validSig }
    });
    assert.equal(hijackRes.status, 403, 'Different browser session must not verify another visitor order');

    // 4f. Payer verifies legitimately -> receives single-use /go/:token
    const verRes = await visitor.req(`/api/unlock/${alias}/verify`, {
      method: 'POST',
      json: { razorpay_order_id: orderId, razorpay_payment_id: fakePayId, razorpay_signature: validSig }
    });
    assert.equal(verRes.status, 200);
    assert.equal(verRes.data.unlocked, true);
    const goPath = verRes.data.redirect_url;
    assert.ok(goPath.startsWith('/go/'));

    // 4g. Attacker trying the intercepted /go/:token from a different browser is blocked!
    const attackerGo = await attacker.req(goPath);
    assert.equal(attackerGo.status, 403, 'Leaked /go/:token must fail on another visitor session');

    // 4h. Payer opens /go/:token -> 302 to exact destination + no-store + no-referrer
    const goRes = await visitor.req(goPath);
    assert.equal(goRes.status, 302);
    assert.equal(goRes.headers.get('location'), 'https://example.com/secret-course.pdf');
    assert.equal(goRes.headers.get('referrer-policy'), 'no-referrer');

    // 4i. Reusing the burned /go/:token fails!
    const replayGo = await visitor.req(goPath);
    assert.equal(replayGo.status, 403, 'One-time token cannot be reused');

    // 4j. Returning to /:alias within unlock window lets payer re-open without paying again
    const gateAgain = await visitor.req(`/api/unlock/${alias}`);
    assert.equal(gateAgain.data.already_unlocked, true);
    const pow2 = solvePow(gateAgain.data.challenge.pow_prefix, gateAgain.data.challenge.pow_difficulty);
    const reopen = await visitor.req(`/api/unlock/${alias}/reopen`, {
      method: 'POST',
      json: { gate_token: gateAgain.data.challenge.gate_token, pow_solution: pow2 }
    });
    assert.equal(reopen.status, 200);
    const go2 = await visitor.req(reopen.data.redirect_url);
    assert.equal(go2.status, 302);
    console.log('✓ Anti-bypass defenses (PoW, cookie binding, signature check, single-use /go/:token, reopen) verified');

    // 5. Creator Webhook + Razorpay Webhook Idempotency
    // Wait briefly for async creator webhook delivery
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(creatorHook.received.length, 1);
    const hookMsg = creatorHook.received[0];
    assert.equal(hookMsg.event, 'payment.paid');
    assert.equal(hookMsg.body.data.link.external_ref, 'tg_9901');
    const sigParts = Object.fromEntries(hookMsg.signature.split(',').map((p) => p.split('=')));
    assert.equal(creatorWebhooks.sign(whSecret, sigParts.t, hookMsg.raw), sigParts.v1);

    // Duplicate Razorpay webhook for the already-paid order must NOT double credit!
    const rzpEvt = JSON.stringify({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: fakePayId, order_id: orderId, amount: 200, currency: 'INR' } } }
    });
    const rzpWhSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rzpEvt).digest('hex');
    const whCall1 = await anon.req('/api/webhooks/razorpay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': rzpWhSig, 'X-Razorpay-Event-Id': 'evt_rzp_1' },
      body: rzpEvt
    });
    assert.equal(whCall1.status, 200);

    const dashCheck = await creator.req('/api/member/dashboard');
    assert.equal(dashCheck.data.user.balance_rupees, 2, 'Balance must still be ₹2 (no double credit)');
    console.log('✓ Signed creator webhook & Razorpay webhook idempotency verified');

    // 6. Admin panel: Commission settings (10%), Withdrawals (Approve -> Pay -> Reject/Refund), Payment Refund
    const admin = new Client(baseUrl);
    const admLogin = await admin.req('/api/auth/login', {
      method: 'POST',
      json: { identifier: 'admin@socialadlinker.com', password: 'AdminPass123' }
    });
    assert.equal(admLogin.status, 200);
    assert.equal(admLogin.data.user.role, 'admin');

    // Update commission to 10% and min withdrawal to ₹1 for test
    const admSet = await admin.req('/api/admin/settings', {
      method: 'PATCH',
      json: { withdrawal_commission_percent: 10, min_withdrawal_rupees: 1 }
    });
    assert.equal(admSet.status, 200);
    assert.equal(admSet.data.settings.withdrawal_commission_percent, 10);

    // Creator requests ₹1 withdrawal -> 10% fee = ₹0.10, net = ₹0.90
    const wd1 = await creator.req('/api/member/withdrawals', {
      method: 'POST',
      json: { amount_rupees: 1, method: 'upi', upi_id: 'botmaker@okaxis' }
    });
    assert.equal(wd1.status, 201);
    assert.equal(wd1.data.withdrawal.commission_rupees, 0.1);
    assert.equal(wd1.data.withdrawal.net_rupees, 0.9);
    assert.equal(wd1.data.user.balance_rupees, 1);

    // Admin approves & marks paid with UTR
    assert.equal((await admin.req(`/api/admin/withdrawals/${wd1.data.withdrawal.id}/approve`, { method: 'POST' })).status, 200);
    assert.equal((await admin.req(`/api/admin/withdrawals/${wd1.data.withdrawal.id}/pay`, { method: 'POST', json: { utr: 'UTR9988776655' } })).status, 200);

    // Second ₹1 withdrawal rejected & refunded to creator wallet
    const wd2 = await creator.req('/api/member/withdrawals', {
      method: 'POST',
      json: { amount_rupees: 1, method: 'upi', upi_id: 'botmaker@okaxis' }
    });
    assert.equal(wd2.status, 201);
    assert.equal((await admin.req(`/api/admin/withdrawals/${wd2.data.withdrawal.id}/reject`, { method: 'POST', json: { admin_note: 'Test reject' } })).status, 200);

    const afterReject = await creator.req('/api/member/withdrawals');
    assert.equal(afterReject.data.user.balance_rupees, 1, 'Rejected withdrawal must refund ₹1 to balance');
    assert.equal(afterReject.data.user.total_withdrawn_rupees, 0.9);

    // Verify public payment proof masks creator & UTR
    const proofsRes = await anon.req('/api/public/payment-proofs');
    assert.equal(proofsRes.status, 200);
    assert.equal(proofsRes.data.proofs.length, 1);
    assert.equal(proofsRes.data.proofs[0].utr, '••••6655');

    // Admin issues Razorpay refund on the ₹2 payment -> debits creator balance by ₹2
    const payList = await admin.req('/api/admin/payments');
    const paidRow = payList.data.payments.find((p) => p.rzp_payment_id === fakePayId);
    const refRes = await admin.req(`/api/admin/payments/${paidRow.id}/refund`, { method: 'POST' });
    assert.equal(refRes.status, 200);

    const ledgerRes = await creator.req('/api/member/ledger');
    assert.equal(ledgerRes.data.entries.some((e) => e.entry_type === 'refund_debit'), true);
    console.log('✓ Commission, withdrawals (pay & reject), masked payment proofs & Razorpay refund verified');

    console.log('\nALL PRODUCTION SOCIALADLINKER TESTS PASSED!');
  } finally {
    server.close();
    mockRzp.server.close();
    creatorHook.server.close();
    await db.close();
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});

