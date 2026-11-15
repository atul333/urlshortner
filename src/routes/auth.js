'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../lib/settings');
const rate = require('../lib/rateLimit');
const mailer = require('../lib/mailer');
const { hashPassword, verifyPassword, generatePublicKey, randomToken, sha256 } = require('../lib/security');
const { HttpError, bad, validateEmail, validateUsername, validatePassword, cleanText } = require('../lib/validators');
const { setSessionCookie, clearSessionCookie, loadUser, sameOrigin } = require('../middleware/auth');
const { serializeUser } = require('../services/users');

const router = express.Router();
router.use(sameOrigin);

// A real hash so that "unknown user" and "wrong password" take the same time.
let dummyHash = null;
hashPassword('timing-equaliser-password-1').then((h) => (dummyHash = h));

router.post('/register', rate.limit({ name: 'register', max: 5, windowMs: 60 * 60 * 1000, message: 'Too many sign-ups from this network. Try again later.' }), async (req, res) => {
  const s = await settings.getAll();
  if (!s.registrations_open) throw new HttpError(403, 'New registrations are temporarily closed.');
  const b = req.body || {};
  if (b.accept_terms !== true && b.accept_terms !== 'on' && b.accept_terms !== 'true') {
    throw bad('Please accept the Terms of Service and Privacy Policy.');
  }
  const username = validateUsername(b.username);
  const email = validateEmail(b.email);
  const password = validatePassword(b.password);
  const fullName = cleanText(b.full_name, 120, 'Full name');

  const exists = await db.one('SELECT id FROM users WHERE lower(username) = $1 OR lower(email) = $2', [username, email]);
  if (exists) throw bad('That username or email is already registered.');

  let referredBy = null;
  if (b.ref) {
    const ref = await db.one("SELECT id FROM users WHERE lower(username) = lower($1) AND status = 'active'", [String(b.ref).slice(0, 32)]);
    referredBy = ref?.id || null;
  }

  const user = await db.one(
    `INSERT INTO users (username, email, password_hash, full_name, public_key, default_price_rupees, referred_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [username, email, await hashPassword(password), fullName, generatePublicKey(), s.default_price_rupees, referredBy]
  );
  setSessionCookie(res, user);
  res.status(201).json({ user: serializeUser(user) });
});

router.post('/login', async (req, res) => {
  const identifier = String(req.body?.identifier || '').trim().toLowerCase().slice(0, 255);
  const password = String(req.body?.password || '');
  if (!identifier || !password) throw bad('Enter your username/email and password.');
  rate.check(`login-ip:${req.ip}`, 30, 15 * 60 * 1000, 'Too many login attempts. Please wait 15 minutes.');
  rate.check(`login-id:${identifier}`, 8, 15 * 60 * 1000, 'Too many login attempts for this account. Please wait 15 minutes.');

  const user = await db.one('SELECT * FROM users WHERE lower(username) = $1 OR lower(email) = $1', [identifier]);
  const ok = user ? await verifyPassword(password, user.password_hash) : (await verifyPassword(password, dummyHash || ''), false);
  if (!user || !ok) throw new HttpError(401, 'Invalid username/email or password.');
  if (user.status !== 'active') throw new HttpError(403, 'Your account is suspended. Please contact support.');

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  setSessionCookie(res, user);
  res.json({ user: serializeUser(user) });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', async (req, res) => {
  const user = await loadUser(req);
  const s = await settings.getAll();
  res.json({ user: user ? serializeUser(user) : null, settings: settings.publicView(s) });
});

router.post('/forgot-password', rate.limit({ name: 'forgot', max: 5, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const email = validateEmail(req.body?.email);
  const user = await db.one("SELECT id, email, username FROM users WHERE lower(email) = $1 AND status = 'active'", [email]);
  if (user) {
    const token = randomToken(32);
    await db.query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [user.id, sha256(token)]
    );
    const link = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const s = await settings.getAll();
    await mailer.sendMail({
      to: user.email,
      subject: `Reset your ${s.site_name} password`,
      text: `Hi ${user.username},\n\nUse the link below to reset your password. It expires in 1 hour.\n\n${link}\n\nIf you did not request this, you can ignore this email.\n\n- ${s.site_name}`
    });
  }
  // Same response either way (no account enumeration)
  res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
});

router.post('/reset-password', rate.limit({ name: 'reset', max: 10, windowMs: 60 * 60 * 1000 }), async (req, res) => {
  const token = String(req.body?.token || '');
  const password = validatePassword(req.body?.password);
  if (token.length < 20) throw bad('Invalid or expired reset link.');
  const result = await db.tx(async (t) => {
    const { rows } = await t.query(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
      [sha256(token)]
    );
    if (!rows[0]) return null;
    const hash = await hashPassword(password);
    const u = await t.query(
      'UPDATE users SET password_hash = $2, token_version = token_version + 1, updated_at = now() WHERE id = $1 RETURNING *',
      [rows[0].user_id, hash]
    );
    return u.rows[0];
  });
  if (!result) throw bad('Invalid or expired reset link. Please request a new one.');
  setSessionCookie(res, result);
  res.json({ ok: true, user: serializeUser(result) });
});

module.exports = router;

