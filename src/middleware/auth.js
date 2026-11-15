'use strict';
const config = require('../config');
const db = require('../db');
const { signPayload, verifyPayload, sha256, hmac, randomToken } = require('../lib/security');
const { HttpError } = require('../lib/validators');

const SESSION_COOKIE = 'sal_session';
const VISITOR_COOKIE = 'sal_vid';
const SESSION_TTL = 30 * 24 * 3600;

const cookieBase = () => ({ httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' });

function setSessionCookie(res, user) {
  const token = signPayload({ uid: user.id, tv: user.token_version }, SESSION_TTL);
  res.cookie(SESSION_COOKIE, token, { ...cookieBase(), maxAge: SESSION_TTL * 1000 });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, cookieBase());
}

async function loadUser(req) {
  if (req._userLoaded) return req.user;
  req._userLoaded = true;
  const data = verifyPayload(req.cookies?.[SESSION_COOKIE]);
  if (!data) return (req.user = null);
  const user = await db.one('SELECT * FROM users WHERE id = $1', [data.uid]);
  if (!user || user.status !== 'active' || user.token_version !== data.tv) return (req.user = null);
  return (req.user = user);
}

async function requireUser(req, res, next) {
  const user = await loadUser(req);
  if (!user) return next(new HttpError(401, 'Please log in to continue.'));
  next();
}

async function requireAdmin(req, res, next) {
  const user = await loadUser(req);
  if (!user) return next(new HttpError(401, 'Please log in to continue.'));
  if (user.role !== 'admin') return next(new HttpError(403, 'Administrator access required.'));
  next();
}

/** CSRF defence for cookie-authenticated state-changing requests. */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin') || req.get('referer');
  if (!origin) return next(); // non-browser clients; SameSite=Lax cookies still protect browsers
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return next(new HttpError(403, 'Invalid request origin.'));
  }
  if (host === config.appHost || host === req.get('host')) return next();
  return next(new HttpError(403, 'Cross-site request blocked.'));
}

/** Developer API key auth: Authorization: Bearer <key>, X-API-Key, or ?api= (legacy). */
async function requireApiKey(req, res, next) {
  const header = req.get('authorization') || '';
  const key = (header.startsWith('Bearer ') ? header.slice(7) : '') || req.get('x-api-key') || req.query.api || req.body?.api || '';
  if (!key || !String(key).startsWith('sal_sk_')) return next(new HttpError(401, 'Missing or invalid API key.'));
  const user = await db.one('SELECT * FROM users WHERE api_key_hash = $1', [sha256(String(key).trim())]);
  if (!user) return next(new HttpError(401, 'Invalid API key.'));
  if (user.status !== 'active') return next(new HttpError(403, 'This account is suspended.'));
  req.apiUser = user;
  next();
}

/** Anonymous visitor identity for unlock flows (httpOnly, never exposed to JS). */
function visitor(req, res, next) {
  let vid = req.cookies?.[VISITOR_COOKIE];
  if (!vid || !/^[A-Za-z0-9_-]{40,60}$/.test(vid)) {
    vid = randomToken(32);
    res.cookie(VISITOR_COOKIE, vid, { ...cookieBase(), maxAge: 365 * 24 * 3600 * 1000 });
  }
  req.visitorHash = hmac(`vid:${vid}`);
  req.ipHash = hmac(`ip:${req.ip}`);
  next();
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  loadUser,
  requireUser,
  requireAdmin,
  sameOrigin,
  requireApiKey,
  visitor,
  sha256
};

