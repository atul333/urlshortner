'use strict';
require('dotenv').config({ quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
const databaseUrl = env.DATABASE_URL || 'pglite:./data/pgdata';

function isLocalDb(url) {
  if (!url || url.startsWith('pglite:')) return true;
  try {
    const u = new URL(url);
    return ['localhost', '127.0.0.1', '::1', 'postgres'].includes(u.hostname);
  } catch {
    return false;
  }
}

const config = {
  isProd,
  isTest,
  port: Number(env.PORT) || 3000,
  appUrl,
  appHost: new URL(appUrl).host,
  trustProxy: env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : (isProd ? 1 : 0),

  // Local PostgreSQL on the EC2 server (or external PostgreSQL).
  // For local development without Postgres you can use: DATABASE_URL=pglite:./data/pgdata
  databaseUrl,
  databaseSsl: bool(env.DATABASE_SSL, isProd && !isLocalDb(databaseUrl)),
  databasePoolMax: Number(env.DATABASE_POOL_MAX) || 20,

  sessionSecret: env.SESSION_SECRET || '',

  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    apiBase: (env.RAZORPAY_API_BASE || 'https://api.razorpay.com/v1').replace(/\/+$/, '')
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'SocialAdLinker <no-reply@socialadlinker.com>'
  },

  // Allow creator webhooks to private/loopback addresses (only for local testing!)
  allowPrivateWebhooks: bool(env.ALLOW_PRIVATE_WEBHOOKS, false)
};

function assertConfig() {
  const problems = [];
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    if (isProd) problems.push('SESSION_SECRET must be set to a random string of at least 32 characters.');
    else config.sessionSecret = 'dev-only-insecure-session-secret-change-me-0123456789';
  }
  if (isProd) {
    if (!config.razorpay.keyId || !config.razorpay.keySecret) problems.push('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required.');
    if (!config.razorpay.webhookSecret) problems.push('RAZORPAY_WEBHOOK_SECRET is required (create a webhook in the Razorpay dashboard).');
    if (!config.appUrl.startsWith('https://')) problems.push('APP_URL must use https:// in production.');
    if (config.databaseUrl.startsWith('pglite:')) problems.push('DATABASE_URL must point to PostgreSQL in production.');
  }
  if (problems.length) {
    console.error('\nConfiguration error:\n - ' + problems.join('\n - ') + '\n');
    process.exit(1);
  }
}

assertConfig();

module.exports = config;

