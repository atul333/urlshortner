'use strict';
const net = require('node:net');
const dns = require('node:dns').promises;
const config = require('../config');

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const bad = (msg) => new HttpError(400, msg);

// Routes that can never be used as custom aliases.
const RESERVED_ALIASES = new Set([
  'api', 'go', 'st', 'js', 'css', 'img', 'assets', 'static', 'public', 'admin', 'member', 'dashboard',
  'login', 'logout', 'register', 'signup', 'forgot-password', 'reset-password', 'pricing', 'developers',
  'developer-api', 'payment-proof', 'payment-proofs', 'about', 'contact', 'terms', 'privacy', 'privacy-policy',
  'dmca', 'refund-policy', 'delivery-policy', 'report', 'report-abuse', 'faq', 'help', 'support', 'blog',
  'webhook', 'webhooks', 'health', 'healthz', 'robots.txt', 'sitemap.xml', 'favicon.ico', 'unlock',
  'socialadlinker', 'www', 'mail', 'status'
]);

/**
 * Cost per link: whole rupees only, minimum ₹1 (configurable), no decimals.
 */
function parseWholeRupees(value, { min = 1, max = 10000, field = 'Price' } = {}) {
  if (value === undefined || value === null || value === '') throw bad(`${field} is required.`);
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) {
    throw bad(`${field} must be a whole number of rupees (1, 2, 3 ...). Decimals like 1.5 are not allowed.`);
  }
  const n = Number(str);
  if (!Number.isSafeInteger(n) || n < min) throw bad(`${field} must be at least ₹${min}.`);
  if (n > max) throw bad(`${field} cannot be more than ₹${max}.`);
  return n;
}

/** Rupee amount with up to 2 decimals -> integer paise */
function parseRupeesToPaise(value, field = 'Amount') {
  const str = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(str)) throw bad(`${field} must be a valid rupee amount (max 2 decimals).`);
  const [r, p = ''] = str.split('.');
  return Number(r) * 100 + Number((p + '00').slice(0, 2));
}

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') throw bad('Destination URL is required.');
  let s = raw.trim();
  if (s.length > 2048) throw bad('Destination URL is too long (max 2048 characters).');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw bad('Please enter a valid URL, for example https://example.com/file');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Only http:// and https:// links are allowed.');
  if (!u.hostname || !u.hostname.includes('.') && u.hostname !== 'localhost') throw bad('Please enter a valid domain name.');
  if (u.username || u.password) throw bad('URLs with embedded credentials are not allowed.');
  // Prevent link loops through our own short links
  if (u.host.toLowerCase() === config.appHost.toLowerCase() || u.hostname.toLowerCase().replace(/^www\./, '') === config.appHost.toLowerCase().replace(/^www\./, '')) {
    throw bad('You cannot shorten a link that points to this website.');
  }
  return u.toString();
}

function validateAlias(alias) {
  const a = String(alias).trim();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(a)) throw bad('Custom alias must be 4-40 characters: letters, numbers, - and _.');
  if (RESERVED_ALIASES.has(a.toLowerCase())) throw bad('This alias is reserved. Please choose another.');
  return a;
}

function cleanText(v, max, field) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) throw bad(`${field} must be at most ${max} characters.`);
  return s;
}

function validateEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('Please enter a valid email address.');
  return s;
}

function validateUsername(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(s)) throw bad('Username must be 3-32 characters: lowercase letters, numbers and underscore.');
  if (RESERVED_ALIASES.has(s) || ['admin', 'administrator', 'root', 'system', 'support'].includes(s)) throw bad('This username is not available.');
  return s;
}

function validatePassword(v) {
  const s = String(v ?? '');
  if (s.length < 8) throw bad('Password must be at least 8 characters.');
  if (s.length > 128) throw bad('Password is too long.');
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw bad('Password must contain at least one letter and one number.');
  return s;
}

function validateUpi(v) {
  const s = String(v ?? '').trim();
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(s)) throw bad('Please enter a valid UPI ID (e.g. name@okaxis).');
  return s;
}

function validateIfsc(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(s)) throw bad('Please enter a valid IFSC code (e.g. HDFC0001234).');
  return s;
}

function validateAccountNumber(v) {
  const s = String(v ?? '').replace(/\s/g, '');
  if (!/^\d{9,18}$/.test(s)) throw bad('Bank account number must be 9-18 digits.');
  return s;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

/** SSRF guard for creator webhook URLs */
async function assertPublicWebhookUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw bad('Webhook URL is not a valid URL.');
  }
  if (config.allowPrivateWebhooks) {
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('Webhook URL must use http(s).');
    return u.toString();
  }
  if (u.protocol !== 'https:') throw bad('Webhook URL must use https://');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw bad('Webhook host could not be resolved.');
  if (addrs.some((a) => isPrivateIp(a.address))) throw bad('Webhook URL must point to a public internet address.');
  return u.toString();
}

function pageParams(query, maxLimit = 100) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(query.limit) || 25)));
  return { page, limit, offset: (page - 1) * limit };
}

module.exports = {
  HttpError,
  bad,
  RESERVED_ALIASES,
  parseWholeRupees,
  parseRupeesToPaise,
  normalizeUrl,
  validateAlias,
  cleanText,
  validateEmail,
  validateUsername,
  validatePassword,
  validateUpi,
  validateIfsc,
  validateAccountNumber,
  assertPublicWebhookUrl,
  isPrivateIp,
  pageParams
};

