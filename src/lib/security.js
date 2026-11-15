'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const config = require('../config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p)
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const hmac = (v, secret = config.sessionSecret) => crypto.createHmac('sha256', secret).update(String(v)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Stateless signed tokens (sessions, gate tokens) ----
function signPayload(payload, ttlSeconds) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verifyPayload(token) {
  if (!token || typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmac(body))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

const ALIAS_CHARS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomAlias(length = 7) {
  let out = '';
  const bytes = crypto.randomBytes(length * 2);
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 256 - (256 % ALIAS_CHARS.length)) out += ALIAS_CHARS[b % ALIAS_CHARS.length];
  }
  return out.length === length ? out : randomAlias(length);
}

function generateApiKey() {
  const key = `sal_sk_${crypto.randomBytes(24).toString('hex')}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 14) };
}

const generatePublicKey = () => `sal_pk_${crypto.randomBytes(12).toString('hex')}`;
const generateWebhookSecret = () => `whsec_${crypto.randomBytes(24).toString('hex')}`;

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  hmac,
  randomToken,
  safeEqual,
  signPayload,
  verifyPayload,
  randomAlias,
  generateApiKey,
  generatePublicKey,
  generateWebhookSecret
};

