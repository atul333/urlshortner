'use strict';
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const config = require('./config');
const db = require('./db');
const { hashPassword, generatePublicKey } = require('./lib/security');
const { HttpError } = require('./lib/validators');
const creatorWebhooks = require('./services/creatorWebhooks');

const webhooksRoute = require('./routes/webhooks');
const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const memberRoutes = require('./routes/member');
const developerRoutes = require('./routes/developer');
const unlockRoutes = require('./routes/unlock');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
        'script-src-attr': ["'unsafe-inline'"],
        'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        'connect-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://lumberjack.razorpay.com'],
        'img-src': ["'self'", 'data:', 'https://*.razorpay.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:']
      }
    },
    crossOriginEmbedderPolicy: false
  }));

  // 1. Health check (used by Nginx / EC2 / Docker health probes)
  app.get('/healthz', async (req, res) => {
    try {
      await db.one('SELECT 1 AS ok');
      res.json({ ok: true, service: 'socialadlinker' });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'database_unavailable' });
    }
  });

  // 2. Razorpay webhook MUST be mounted BEFORE express.json() to receive raw JSON body
  app.use(webhooksRoute);

  // 3. Body & Cookie Parsers
  app.use(express.json({ limit: '512kb' }));
  app.use(express.urlencoded({ extended: false, limit: '512kb' }));
  app.use(cookieParser());

  // 4. API & Protected Redirect Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/member', memberRoutes);
  app.use('/api/v1', developerRoutes.v1);
  app.use('/api/admin', adminRoutes);
  app.use(developerRoutes.legacy);
  app.use(unlockRoutes);

  // 5. Static Assets & Robots
  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /go/\nDisallow: /api/\nDisallow: /admin\n');
  });
  app.use(express.static(publicDir, { index: 'index.html', maxAge: config.isProd ? '1h' : 0 }));

  // 6. Frontend SPA Routes
  const spaRoutes = [
    '/', '/pricing', '/developers', '/developer-api', '/payment-proof', '/payment-proofs',
    '/about', '/contact', '/terms', '/privacy', '/refund-policy', '/delivery-policy',
    '/report', '/report-abuse', '/login', '/register', '/forgot-password', '/reset-password',
    '/member', '/admin'
  ];
  for (const r of spaRoutes) {
    app.get(r, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  }

  // 7. Catch-all Short Link Route: /:alias -> Anti-Bypass Razorpay Unlock Gate
  app.get('/:alias', (req, res, next) => {
    const alias = req.params.alias;
    if (!alias || alias.includes('.')) return next();
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow'
    });
    res.sendFile(path.join(publicDir, 'unlock.html'));
  });

  // 8. API 404 & Centralized Error Handler
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON request body.' });
    }
    console.error('[error]', req.method, req.originalUrl, err);
    const status = err.status || 500;
    const message = status < 500 ? err.message : 'An unexpected server error occurred. Please try again.';
    res.status(status).json({ error: message });
  });

  return app;
}

/** Optional one-time Admin bootstrap via environment variables (only runs if no admin exists). */
async function bootstrapInitialAdmin() {
  const email = (process.env.ADMIN_INIT_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_INIT_PASSWORD || '';
  const username = (process.env.ADMIN_INIT_USERNAME || 'admin').trim().toLowerCase();
  if (!email || !password) return;
  const existingAdmin = await db.one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existingAdmin) return;
  const hash = await hashPassword(password);
  await db.query(
    `INSERT INTO users (username, email, password_hash, full_name, role, public_key, default_price_rupees)
     VALUES ($1, $2, $3, 'Platform Administrator', 'admin', $4, 1)
     ON CONFLICT DO NOTHING`,
    [username, email, hash, generatePublicKey()]
  );
  console.log(`[bootstrap] Initial admin account ensured for ${email}`);
}

async function start() {
  await db.migrate();
  await bootstrapInitialAdmin();
  creatorWebhooks.resumePending().catch((e) => console.error('[webhook] resume error:', e.message));

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`SocialAdLinker server listening on ${config.appUrl} (port ${config.port}, env=${config.isProd ? 'production' : 'development'})`);
  });

  const shutdown = async (sig) => {
    console.log(`[shutdown] received ${sig}, closing server...`);
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { app, server };
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = { createApp, start, bootstrapInitialAdmin };

