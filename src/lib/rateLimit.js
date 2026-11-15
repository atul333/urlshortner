'use strict';
const { HttpError } = require('./validators');

/**
 * Small fixed-window in-memory rate limiter.
 * For multi-server deployments, Nginx `limit_req` (see deploy/nginx.conf) provides an
 * additional shared edge limit.
 */
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60_000).unref();

function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { allowed: b.count <= max, remaining: Math.max(0, max - b.count), reset: b.reset };
}

function check(key, max, windowMs, message = 'Too many requests. Please slow down and try again shortly.') {
  const r = hit(key, max, windowMs);
  if (!r.allowed) {
    throw new HttpError(429, message, { retryAfter: Math.ceil((r.reset - Date.now()) / 1000) });
  }
  return r;
}

function limit({ name, max, windowMs, key = (req) => req.ip, message }) {
  return (req, res, next) => {
    const r = hit(`${name}:${key(req)}`, max, windowMs);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(Math.ceil((r.reset - Date.now()) / 1000)));
      return next(new HttpError(429, message || 'Too many requests. Please slow down and try again shortly.'));
    }
    next();
  };
}

module.exports = { limit, check, _reset: () => buckets.clear() };

