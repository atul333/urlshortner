// ============================================================================
// SocialAdLinker (https://www.socialadlinker.com) — Production Frontend SPA
// ============================================================================

const state = {
  user: null,
  settings: {
    site_name: 'SocialAdLinker',
    site_tagline: 'Pay-per-link shortener for creators. No ads, ever.',
    company_name: 'SocialAdLinker',
    support_email: 'support@socialadlinker.com',
    support_phone: '',
    business_address: '',
    grievance_officer: '',
    default_price_rupees: 1,
    min_price_rupees: 1,
    max_price_rupees: 5000,
    withdrawal_commission_percent: 0,
    min_withdrawal_rupees: 100,
    referral_percent: 0,
    unlock_validity_hours: 24,
    max_opens_per_payment: 10,
    registrations_open: true,
    show_public_stats: true,
    announcement: ''
  },
  publicStats: null,
  paymentsEnabled: false,
  proofs: [],
  route: 'home',
  memberTab: 'stats',
  adminTab: 'overview',
  dashboard: null,
  links: [],
  linksSearch: '',
  linksStatus: '',
  massResults: null,
  lastCreatedLink: null,
  withdrawals: [],
  ledger: [],
  referrals: null,
  revealedApiKey: null,
  revealedWebhookSecret: null,
  webhookDeliveries: [],
  tickets: [],
  adminOverview: null,
  adminWithdrawals: [],
  adminWithdrawalFilter: '',
  adminUsers: [],
  adminUsersSearch: '',
  adminLinks: [],
  adminLinksSearch: '',
  adminPayments: [],
  adminSettings: null,
  adminReports: { reports: [], contacts: [] },
  adminTickets: [],
  adminLogs: [],
  calcPrice: 2,
  calcClicks: 1000,
  devLang: 'python',
  mobileMenuOpen: false,
  mobileSidebarOpen: false
};

// ============================================================================
// HELPERS
// ============================================================================

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtINR(val) {
  const n = Number(val) || 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(iso);
  }
}

function toast(msg, isError = false) {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function copyText(text, label = 'Copied to clipboard!') {
  navigator.clipboard.writeText(text);
  toast(label);
}

function validateWholeRupeesClient(raw) {
  const s = String(raw ?? '').trim();
  const min = state.settings.min_price_rupees || 1;
  const max = state.settings.max_price_rupees || 5000;
  if (!/^\d+$/.test(s)) {
    return { valid: false, error: 'Price per link must be a whole number (1, 2, 3...). Decimals like 1.5 are not allowed.' };
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) return { valid: false, error: `Minimum price per link is ₹${min}.` };
  if (n > max) return { valid: false, error: `Maximum price per link is ₹${max}.` };
  return { valid: true, price: n };
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showModal(html) {
  document.getElementById('modalRoot').innerHTML = `<div class="modal-backdrop" onclick="if(event.target===this) closeModal()">${html}</div>`;
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
}

function toggleMobileMenu() {
  state.mobileMenuOpen = !state.mobileMenuOpen;
  render();
}

function closeMobileMenu() {
  if (state.mobileMenuOpen) {
    state.mobileMenuOpen = false;
    render();
  }
}

function toggleMobileSidebar() {
  state.mobileSidebarOpen = !state.mobileSidebarOpen;
  render();
}

function closeMobileSidebar() {
  if (state.mobileSidebarOpen) {
    state.mobileSidebarOpen = false;
    render();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('modalRoot')?.innerHTML) closeModal();
    if (state.mobileMenuOpen || state.mobileSidebarOpen) {
      state.mobileMenuOpen = false;
      state.mobileSidebarOpen = false;
      render();
    }
  }
});

// ============================================================================
// ROUTER & BOOTSTRAP
// ============================================================================

const ROUTE_PATHS = {
  home: '/',
  pricing: '/pricing',
  developers: '/developers',
  'payment-proof': '/payment-proof',
  about: '/about',
  contact: '/contact',
  terms: '/terms',
  privacy: '/privacy',
  'refund-policy': '/refund-policy',
  'delivery-policy': '/delivery-policy',
  report: '/report',
  login: '/login',
  register: '/register',
  'forgot-password': '/forgot-password',
  'reset-password': '/reset-password',
  member: '/member',
  admin: '/admin'
};

function pathToRoute(pathname) {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  if (!clean) return 'home';
  if (clean === 'developer-api') return 'developers';
  if (clean === 'payment-proofs') return 'payment-proof';
  if (clean === 'report-abuse') return 'report';
  if (ROUTE_PATHS[clean]) return clean;
  return 'home';
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('ref')) localStorage.setItem('sal_ref', params.get('ref'));
  state.route = pathToRoute(window.location.pathname);

  try {
    const info = await api('/api/public/info');
    state.settings = info.settings;
    state.publicStats = info.stats;
    state.paymentsEnabled = info.payments_enabled;
  } catch (e) {
    console.error(e);
  }

  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    if (me.settings) state.settings = me.settings;
  } catch {
    state.user = null;
  }

  if (state.route === 'payment-proof') {
    await loadProofs();
  } else if (state.route === 'member') {
    if (!state.user) state.route = 'login';
    else await loadMemberTab(state.memberTab);
  } else if (state.route === 'admin') {
    if (!state.user) state.route = 'login';
    else if (state.user.role !== 'admin') {
      state.route = 'member';
      await loadMemberTab('stats');
    } else {
      await loadAdminTab(state.adminTab);
    }
  }
  render();
}

async function navigate(route, subTab = null) {
  state.mobileMenuOpen = false;
  state.mobileSidebarOpen = false;
  state.route = route;
  if (route === 'member') {
    if (!state.user) {
      state.route = 'login';
      window.history.pushState({}, '', '/login');
      render();
      return;
    }
    if (subTab) state.memberTab = subTab;
    window.history.pushState({}, '', '/member');
    await loadMemberTab(state.memberTab);
  } else if (route === 'admin') {
    if (!state.user || state.user.role !== 'admin') {
      toast('Administrator login required.', true);
      state.route = state.user ? 'member' : 'login';
      render();
      return;
    }
    if (subTab) state.adminTab = subTab;
    window.history.pushState({}, '', '/admin');
    await loadAdminTab(state.adminTab);
  } else {
    window.history.pushState({}, '', ROUTE_PATHS[route] || '/');
    if (route === 'payment-proof') await loadProofs();
  }
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', () => bootstrap());

async function loadProofs() {
  try {
    const res = await api('/api/public/payment-proofs');
    state.proofs = res.proofs || [];
  } catch {}
}

async function loadMemberTab(tab) {
  state.memberTab = tab;
  try {
    if (tab === 'stats') {
      const d = await api('/api/member/dashboard');
      state.dashboard = d;
      state.user = d.user;
      state.settings = d.settings;
    } else if (tab === 'links') {
      const d = await api(`/api/member/links?q=${encodeURIComponent(state.linksSearch)}&status=${encodeURIComponent(state.linksStatus)}`);
      state.links = d.links;
    } else if (tab === 'withdraw') {
      const [w, l] = await Promise.all([api('/api/member/withdrawals'), api('/api/member/ledger?limit=50')]);
      state.user = w.user;
      state.settings = w.settings;
      state.withdrawals = w.withdrawals;
      state.ledger = l.entries;
    } else if (tab === 'api') {
      const d = await api('/api/member/webhook/deliveries');
      state.webhookDeliveries = d.deliveries || [];
    } else if (tab === 'referrals') {
      state.referrals = await api('/api/member/referrals');
    } else if (tab === 'support') {
      const d = await api('/api/member/tickets');
      state.tickets = d.tickets || [];
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadAdminTab(tab) {
  state.adminTab = tab;
  try {
    if (tab === 'overview') {
      state.adminOverview = await api('/api/admin/overview');
      state.adminSettings = state.adminOverview.settings;
    } else if (tab === 'withdrawals') {
      const d = await api(`/api/admin/withdrawals?status=${encodeURIComponent(state.adminWithdrawalFilter)}`);
      state.adminWithdrawals = d.withdrawals;
    } else if (tab === 'payments') {
      const d = await api('/api/admin/payments?limit=50');
      state.adminPayments = d.payments;
    } else if (tab === 'users') {
      const d = await api(`/api/admin/users?q=${encodeURIComponent(state.adminUsersSearch)}`);
      state.adminUsers = d.users;
    } else if (tab === 'links') {
      const d = await api(`/api/admin/links?q=${encodeURIComponent(state.adminLinksSearch)}`);
      state.adminLinks = d.links;
    } else if (tab === 'reports') {
      state.adminReports = await api('/api/admin/reports');
    } else if (tab === 'tickets') {
      const d = await api('/api/admin/tickets');
      state.adminTickets = d.tickets;
    } else if (tab === 'settings') {
      const d = await api('/api/admin/settings');
      state.adminSettings = d.settings;
    } else if (tab === 'logs') {
      const d = await api('/api/admin/audit-logs');
      state.adminLogs = d.logs;
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function render() {
  const root = document.getElementById('app');
  if (state.route === 'member' && state.user) {
    root.innerHTML = renderMemberShell();
  } else if (state.route === 'admin' && state.user?.role === 'admin') {
    root.innerHTML = renderAdminShell();
  } else {
    root.innerHTML = renderPublicLayout();
  }
  const strip = root.querySelector('.mobile-tab-strip');
  const activeTab = strip?.querySelector('.mobile-tab-pill.active');
  if (strip && activeTab) {
    strip.scrollLeft = Math.max(0, activeTab.offsetLeft - (strip.clientWidth - activeTab.clientWidth) / 2);
  }
}

// ============================================================================
// PUBLIC PAGES
// ============================================================================

function renderPublicNavbar() {
  const s = state.settings;
  return `
    <header class="public-navbar">
      <div class="nav-container">
        <div class="nav-top-row">
          <div class="brand-logo" onclick="navigate('home')">
            <span class="brand-logo-icon">SA</span>
            <span>${esc(s.site_name)}</span>
            <span class="brand-badge hide-xs">Zero Ads</span>
          </div>

          <button type="button" class="mobile-menu-btn" aria-label="Toggle navigation menu" aria-expanded="${state.mobileMenuOpen ? 'true' : 'false'}" onclick="toggleMobileMenu()">
            ${state.mobileMenuOpen ? '✕' : '☰'}
          </button>
        </div>

        <div class="nav-collapse ${state.mobileMenuOpen ? 'open' : ''}">
          <nav class="nav-links">
            <span class="nav-link ${state.route === 'home' ? 'active' : ''}" onclick="navigate('home')">Home</span>
            <span class="nav-link ${state.route === 'pricing' ? 'active' : ''}" onclick="navigate('pricing')">Pricing &amp; CPM</span>
            <span class="nav-link ${state.route === 'developers' ? 'active' : ''}" onclick="navigate('developers')">API &amp; Bots</span>
            <span class="nav-link ${state.route === 'payment-proof' ? 'active' : ''}" onclick="navigate('payment-proof')">Payouts</span>
            <span class="nav-link ${state.route === 'contact' ? 'active' : ''}" onclick="navigate('contact')">Contact</span>
          </nav>

          <div class="nav-actions">
            ${state.user ? `
              <button class="btn btn-sm btn-primary" onclick="navigate('member', 'stats')">Dashboard</button>
              ${state.user.role === 'admin' ? `<button class="btn btn-sm btn-amber" onclick="navigate('admin', 'overview')">Admin</button>` : ''}
              <button class="btn btn-sm btn-ghost-light" onclick="logout()">Logout</button>
            ` : `
              <button class="btn btn-sm btn-ghost-light" onclick="navigate('login')">Login</button>
              <button class="btn btn-sm btn-emerald" onclick="navigate('register')">Start Earning</button>
            `}
          </div>
        </div>
      </div>
    </header>
  `;
}

function renderPublicLayout() {
  let body = '';
  switch (state.route) {
    case 'pricing': body = renderPricingPage(); break;
    case 'developers': body = renderDevelopersPage(); break;
    case 'payment-proof': body = renderPaymentProofPage(); break;
    case 'about': body = renderAboutPage(); break;
    case 'contact': body = renderContactPage(); break;
    case 'terms': body = renderTermsPage(); break;
    case 'privacy': body = renderPrivacyPage(); break;
    case 'refund-policy': body = renderRefundPolicyPage(); break;
    case 'delivery-policy': body = renderDeliveryPolicyPage(); break;
    case 'report': body = renderReportPage(); break;
    case 'login': body = renderLoginPage(); break;
    case 'register': body = renderRegisterPage(); break;
    case 'forgot-password': body = renderForgotPage(); break;
    case 'reset-password': body = renderResetPage(); break;
    default: body = renderHomePage();
  }
  return `${renderPublicNavbar()}<main>${body}</main>${renderPublicFooter()}`;
}

function renderHomePage() {
  const s = state.settings;
  const st = state.publicStats;
  return `
    <section class="hero-section">
      <div class="hero-container">
        <div class="hero-pill">
          <span>🔒</span>
          <span>Built for Creators • Zero Ads • Razorpay UPI &amp; Anti-Bypass Protection</span>
        </div>

        <h1 class="hero-title">
          Replace Boring Ad Shorteners With <br class="hide-mobile" />
          <span>Direct Razorpay Paid Links</span>
        </h1>

        <p class="hero-subtitle">
          Set your own unlock price starting at <strong>₹${s.default_price_rupees} per link</strong> (whole rupees only: ₹1, ₹2, ₹3...). Your audience pays once via UPI or Cards to open the final destination immediately — zero popups, zero timers, and strong server-side anti-bypass security.
        </p>

        <div class="hero-cta-row">
          ${state.user ? `
            <button class="btn btn-emerald btn-lg" onclick="navigate('member', 'stats')">Open Creator Dashboard →</button>
            <button class="btn btn-ghost-light btn-lg" onclick="navigate('developers')">View Telegram Bot API</button>
          ` : `
            <button class="btn btn-emerald btn-lg" onclick="navigate('register')">Create Free Creator Account →</button>
            <button class="btn btn-ghost-light btn-lg" onclick="navigate('developers')">Telegram Bot &amp; REST API</button>
          `}
        </div>

        ${st ? `
          <div class="stats-strip">
            <div class="stat-glass-card">
              <div class="stat-glass-value">${Number(st.creators).toLocaleString('en-IN')}</div>
              <div class="stat-glass-label">Registered Creators</div>
            </div>
            <div class="stat-glass-card">
              <div class="stat-glass-value">${Number(st.links).toLocaleString('en-IN')}</div>
              <div class="stat-glass-label">Protected Links</div>
            </div>
            <div class="stat-glass-card">
              <div class="stat-glass-value">${Number(st.unlocks).toLocaleString('en-IN')}</div>
              <div class="stat-glass-label">Verified Razorpay Unlocks</div>
            </div>
            <div class="stat-glass-card">
              <div class="stat-glass-value">${fmtINR(st.paid_out_rupees)}</div>
              <div class="stat-glass-label">Paid Out to Creators</div>
            </div>
          </div>
        ` : ''}
      </div>
    </section>

    <!-- How It Works -->
    <section class="section-container">
      <div class="section-header">
        <span class="section-tag">How SocialAdLinker Works</span>
        <h2 class="section-title">3 Steps From Link Creation to Bank Payout</h2>
        <p style="color: var(--text-muted); margin-top: 0.5rem;">
          No third-party ad networks. No multi-page countdowns. Just transparent micro-payments settled directly to your UPI or Bank Account.
        </p>
      </div>
      <div class="grid-3">
        <div class="feature-card">
          <div class="feature-icon">1</div>
          <h3>Shorten &amp; Set Whole-Rupee Price</h3>
          <p>Shorten any URL in the dashboard, Mass Shrinker, or automatically via our Telegram Bot REST API. Default price is <strong>₹1</strong>, or charge ₹2, ₹5, ₹10+ per link.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon" style="background:#dcfce7; color:#059669;">2</div>
          <h3>Visitor Unlocks via Razorpay</h3>
          <p>Your visitor sees a fast, clean checkout card with GPay, PhonePe, Paytm, UPI QR, and Cards. Once verified server-side, they unlock the link immediately.</p>
        </div>
        <div class="feature-card">
          <div class="feature-icon" style="background:#fef3c7; color:#d97706;">3</div>
          <h3>Collect &amp; Withdraw Earnings</h3>
          <p>Every verified payment credits your immutable Wallet Ledger in real time. Request a collective withdrawal to your UPI ID or Bank Account anytime.</p>
        </div>
      </div>
    </section>

    <!-- Use Cases -->
    <section style="background:#ffffff; border-top:1px solid var(--border); border-bottom:1px solid var(--border);">
      <div class="section-container">
        <div class="section-header">
          <span class="section-tag">Built For Creators</span>
          <h2 class="section-title">Who Uses SocialAdLinker?</h2>
        </div>
        <div class="grid-3">
          <div class="feature-card">
            <div class="feature-icon">🤖</div>
            <h3>Telegram Bot &amp; Channel Owners</h3>
            <p>Connect your Telegram bot to <code>POST /api/v1/links</code> or <code>/api</code> to auto-wrap file links with ₹1+ unlock gates and receive instant webhook callbacks.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">📚</div>
            <h3>Notes, Courses &amp; PDF Creators</h3>
            <p>Monetize study materials, exam notes, Figma kits, presets, and Notion templates without needing a full e-commerce store.</p>
          </div>
          <div class="feature-card">
            <div class="feature-icon">💻</div>
            <h3>Software, Scripts &amp; App Makers</h3>
            <p>Charge a fair whole-rupee unlock fee (₹5, ₹20, ₹50) for builds, source repos, or private links with automatic 24-hour re-access for buyers.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Anti-Bypass Security Architecture -->
    <section class="section-container">
      <div class="section-header">
        <span class="section-tag">Anti-Bypass Protection</span>
        <h2 class="section-title">Multi-Layer Server Security — Impossible to Scrape</h2>
        <p style="color:var(--text-muted); margin-top:0.5rem;">
          Traditional ad shorteners leak final URLs in client JavaScript or predictable redirect steps. SocialAdLinker protects every destination on the server.
        </p>
      </div>
      <div class="grid-2">
        <div class="feature-card">
          <h3>Zero Destination Exposure Before Payment</h3>
          <p>Destination URLs are stored strictly in PostgreSQL and never sent in HTML, JSON API responses, or browser bundles prior to verified Razorpay settlement.</p>
        </div>
        <div class="feature-card">
          <h3>Server-to-Server Razorpay &amp; Signature Verification</h3>
          <p>Every checkout callback is validated with HMAC-SHA256 AND verified directly against Razorpay's Payments API for exact INR amount, order ID, and captured state.</p>
        </div>
        <div class="feature-card">
          <h3>Single-Use Burnable Redirect Tokens + Session Binding</h3>
          <p>Unlocked links issue a 120-second single-use <code>/go/:token</code> bound to an <code>httpOnly</code> signed visitor cookie — shared redirect links immediately fail on other devices.</p>
        </div>
        <div class="feature-card">
          <h3>Browser Challenge, Bot Filtering &amp; Rate Limits</h3>
          <p>Automated curl/headless bypass scrapers are blocked via signed gate nonces, lightweight Proof-of-Work browser verification, and edge + API rate limiting.</p>
        </div>
      </div>
    </section>

    <!-- FAQ -->
    <section style="background:#ffffff; border-top:1px solid var(--border);">
      <div class="section-container" style="max-width: 880px;">
        <div class="section-header">
          <span class="section-tag">FAQ</span>
          <h2 class="section-title">Frequently Asked Questions</h2>
        </div>

        <details class="faq-item" open>
          <summary>What prices can creators set per link?</summary>
          <p>Creators start with a default of <strong>₹${s.default_price_rupees} per link</strong> (₹${s.default_price_rupees * 1000} effective CPM). You can set any whole-rupee integer price starting from ₹${s.min_price_rupees} (e.g., 1, 2, 3, 5, 10). Decimal amounts like 1.5 are blocked to keep UPI checkout clean.</p>
        </details>
        <details class="faq-item">
          <summary>How do payouts and platform commission work?</summary>
          <p>100% of each verified Razorpay unlock is credited to your creator wallet immediately. When you request a collective withdrawal (minimum ${fmtINR(s.min_withdrawal_rupees)}) to your UPI ID or Bank Account, the configured platform fee (currently <strong>${s.withdrawal_commission_percent}%</strong>) is deducted and the net amount is transferred directly.</p>
        </details>
        <details class="faq-item">
          <summary>Can I integrate SocialAdLinker with my Telegram bot or website?</summary>
          <p>Yes! Generate a secret API key in your Creator Dashboard and use our REST API (<code>POST /api/v1/links</code>), legacy drop-in endpoint (<code>/api?api=...&amp;url=...</code>), or signed HTTPS webhooks (<code>payment.paid</code>) to automate link creation and unlock fulfillment.</p>
        </details>
        <details class="faq-item">
          <summary>If a user already paid, do they have to pay again on refresh?</summary>
          <p>No. Verified buyers automatically keep access in their browser session for <strong>${s.unlock_validity_hours} hours</strong> (up to ${s.max_opens_per_payment} opens) without being charged again, while preventing leaked links from working on other people's devices.</p>
        </details>
      </div>
    </section>
  `;
}

function renderPricingPage() {
  const s = state.settings;
  const price = state.calcPrice;
  const clicks = state.calcClicks;
  const gross = price * clicks;
  const commPct = s.withdrawal_commission_percent;
  const commAmt = +(gross * commPct / 100).toFixed(2);
  const net = +(gross - commAmt).toFixed(2);

  return `
    <section class="section-container">
      <div class="section-header">
        <span class="section-tag">Transparent Earnings</span>
        <h2 class="section-title">Creator-Controlled CPM &amp; Payout Calculator</h2>
        <p style="color:var(--text-muted); margin-top:0.5rem;">
          You decide what every link costs in whole rupees (minimum ₹${s.min_price_rupees}). Visitors pay zero ad-wall frustration; you earn up to 100× more than traditional ad shorteners.
        </p>
      </div>

      <div class="card" style="max-width:860px; margin:0 auto 2rem;">
        <div class="card-header">
          <div class="card-title">Live Earnings Estimator</div>
          <span class="badge badge-indigo">Withdrawal Commission: ${commPct}%</span>
        </div>
        <div class="grid-2" style="margin-bottom:1.25rem;">
          <div class="form-group">
            <label class="form-label">Price Per Link (Whole ₹: 1, 2, 3...)</label>
            <input type="number" class="form-control" min="${s.min_price_rupees}" max="${s.max_price_rupees}" step="1" value="${price}" oninput="updateCalc('price', this.value)" />
          </div>
          <div class="form-group">
            <label class="form-label">Paid Unlocks</label>
            <input type="number" class="form-control" min="1" step="1" value="${clicks}" oninput="updateCalc('clicks', this.value)" />
          </div>
        </div>
        <div class="kpi-grid" style="margin-bottom:0;">
          <div class="kpi-card indigo">
            <div class="kpi-label">Effective CPM</div>
            <div class="kpi-value">${fmtINR(price * 1000)}</div>
            <div class="kpi-sub">Per 1,000 unlocks</div>
          </div>
          <div class="kpi-card emerald">
            <div class="kpi-label">Wallet Credit</div>
            <div class="kpi-value">${fmtINR(gross)}</div>
            <div class="kpi-sub">${clicks.toLocaleString('en-IN')} × ₹${price}</div>
          </div>
          <div class="kpi-card amber">
            <div class="kpi-label">Platform Fee (${commPct}%)</div>
            <div class="kpi-value">${fmtINR(commAmt)}</div>
            <div class="kpi-sub">Applied only on withdrawal</div>
          </div>
          <div class="kpi-card cyan">
            <div class="kpi-label">Net Payout</div>
            <div class="kpi-value">${fmtINR(net)}</div>
            <div class="kpi-sub">Via UPI / Bank Transfer</div>
          </div>
        </div>
      </div>

      <div class="card" style="max-width:860px; margin:0 auto;">
        <div class="card-header"><div class="card-title">Whole-Rupee Link Pricing Reference</div></div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr><th>Link Price</th><th>Effective CPM</th><th>Withdrawal Fee (${commPct}%)</th><th>Net Per 1,000 Unlocks</th></tr>
            </thead>
            <tbody>
              ${[1, 2, 3, 5, 10, 25, 50].map((p) => {
                const g = p * 1000;
                const n = +(g - g * commPct / 100).toFixed(2);
                return `<tr>
                  <td><strong>₹${p}</strong> ${p === s.default_price_rupees ? '<span class="badge badge-success">Default</span>' : ''}</td>
                  <td>${fmtINR(g)}</td>
                  <td>${fmtINR(+(g * commPct / 100).toFixed(2))}</td>
                  <td><strong style="color:var(--emerald-dark);">${fmtINR(n)}</strong></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function updateCalc(field, val) {
  const n = Math.max(1, Math.floor(Number(val) || 1));
  if (field === 'price') state.calcPrice = n;
  else state.calcClicks = n;
  render();
}

function renderDevelopersPage() {
  const origin = window.location.origin;
  const examples = {
    python: `import os, requests

API_KEY = os.environ["SOCIALADLINKER_API_KEY"]  # sal_sk_...

# Telegram Bot handler example: shorten any URL & charge ₹2 per unlock
res = requests.post(
    "${origin}/api/v1/links",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "url": "https://drive.google.com/file/d/example/view",
        "price": 2,                # Whole rupees >= 1
        "title": "Course PDF Pack",
        "ref": "tg_user_98124"     # Track your Telegram user/order ID
    },
    timeout=10,
)
data = res.json()["link"]
print("Send this paid link to user:", data["short_url"])`,
    node: `const res = await fetch("${origin}/api/v1/links", {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${process.env.SOCIALADLINKER_API_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://example.com/resource.zip",
    price: 5,
    title: "UI Design Kit",
    ref: "order_1049",
  }),
});
const { link } = await res.json();
console.log("Paid link:", link.short_url);`,
    curl: `# JSON REST API (Recommended)
curl -X POST "${origin}/api/v1/links" \\
  -H "Authorization: Bearer sal_sk_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://example.com/file","price":2,"title":"Notes PDF","ref":"bot_42"}'

# Simple Drop-in Endpoint (JSON or Plain Text)
curl "${origin}/api?api=sal_sk_YOUR_KEY&url=https://example.com/file&price=1&format=text"`,
    webhook: `// Verify SocialAdLinker Webhook in Express.js (when a visitor pays!)
const crypto = require("node:crypto");

app.post("/socialadlinker-webhook", express.raw({ type: "application/json" }), (req, res) => {
  const header = req.get("x-sal-signature") || "";
  const parts = Object.fromEntries(header.split(",").map(p => p.split("=")));
  const expected = crypto
    .createHmac("sha256", process.env.SAL_WEBHOOK_SECRET)
    .update(\`\${parts.t}.\${req.body.toString("utf8")}\`)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 || ""))) {
    return res.status(400).send("Invalid signature");
  }
  const event = JSON.parse(req.body.toString("utf8"));
  if (event.event === "payment.paid") {
    console.log("Unlocked ref:", event.data.link.external_ref, "₹", event.data.amount_rupees);
  }
  res.json({ received: true });
});`
  };

  return `
    <section class="section-container">
      <div class="section-header">
        <span class="section-tag">Developer &amp; Bot API</span>
        <h2 class="section-title">Automate Paid Links in Telegram Bots, Websites &amp; Apps</h2>
        <p style="color:var(--text-muted); margin-top:0.5rem;">
          Generate your secret API key (<code>sal_sk_...</code>) inside <a href="javascript:void(0)" onclick="navigate('member', 'api')">Dashboard → API &amp; Webhooks</a>.
        </p>
      </div>

      <div class="card" style="max-width:960px; margin:0 auto 1.5rem;">
        <div class="card-header">
          <div class="card-title">Code Examples &amp; Telegram Bot Integration</div>
          <div class="tab-pills" style="margin-bottom:0;">
            ${['python', 'node', 'curl', 'webhook'].map((k) => `
              <button class="tab-pill ${state.devLang === k ? 'active' : ''}" onclick="state.devLang='${k}'; render();">
                ${k === 'python' ? 'Python / Telegram Bot' : k === 'node' ? 'Node.js' : k === 'curl' ? 'cURL & Drop-in /api' : 'Webhook Verification'}
              </button>
            `).join('')}
          </div>
        </div>
        <div class="code-block">${esc(examples[state.devLang])}</div>
      </div>

      <div class="card" style="max-width:960px; margin:0 auto;">
        <div class="card-header"><div class="card-title">REST API v1 Reference</div></div>
        <div class="table-responsive">
          <table>
            <thead><tr><th>Method &amp; Endpoint</th><th>Description</th></tr></thead>
            <tbody>
              <tr><td><code>POST /api/v1/links</code></td><td>Create a paid short link (<code>url</code>, optional <code>price</code> whole ₹, <code>alias</code>, <code>title</code>, <code>ref</code>, <code>expires_at</code>).</td></tr>
              <tr><td><code>GET /api/v1/links</code></td><td>List links with pagination and <code>?q=</code>, <code>?ref=</code>, <code>?status=</code> filters.</td></tr>
              <tr><td><code>GET /api/v1/links/:alias</code></td><td>Fetch live clicks, paid unlocks, and revenue for one link.</td></tr>
              <tr><td><code>PATCH /api/v1/links/:alias</code></td><td>Update <code>price</code> (whole ₹), <code>title</code>, <code>url</code>, or <code>status</code> (<code>active</code>/<code>paused</code>).</td></tr>
              <tr><td><code>DELETE /api/v1/links/:alias</code></td><td>Soft-delete and deactivate a short link.</td></tr>
              <tr><td><code>GET /api/v1/payments</code></td><td>List verified Razorpay unlock payments (filter by <code>?alias=</code> or <code>?ref=</code>).</td></tr>
              <tr><td><code>GET /api/v1/account</code></td><td>Get current wallet balance, default price, and webhook configuration.</td></tr>
              <tr><td><code>GET /api?api=...&amp;url=...</code></td><td>Drop-in shortener supporting <code>&amp;format=json</code> or <code>&amp;format=text</code>.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderPaymentProofPage() {
  return `
    <section class="section-container">
      <div class="section-header">
        <span class="section-tag">Verified Payouts</span>
        <h2 class="section-title">Recent Creator Payouts</h2>
        <p style="color:var(--text-muted); margin-top:0.5rem;">
          Public ledger of completed collective payouts (usernames &amp; UTR numbers are privacy-masked).
        </p>
      </div>
      <div class="card" style="max-width:960px; margin:0 auto;">
        <div class="table-responsive">
          <table>
            <thead><tr><th>Payout #</th><th>Creator</th><th>Method</th><th>Net Paid</th><th>UTR Ref</th><th>Settled On</th></tr></thead>
            <tbody>
              ${state.proofs.length === 0 ? `
                <tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No completed payouts recorded yet.</td></tr>
              ` : state.proofs.map((p) => `
                <tr>
                  <td>#${p.id}</td>
                  <td><strong>${esc(p.creator)}</strong></td>
                  <td><span class="badge badge-indigo">${esc(p.method)}</span></td>
                  <td><strong style="color:var(--emerald-dark);">${fmtINR(p.amount_rupees)}</strong></td>
                  <td><code>${esc(p.utr || 'Settled')}</code></td>
                  <td>${fmtDate(p.paid_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderAboutPage() {
  const s = state.settings;
  return `
    <section class="section-container">
      <div class="prose-card">
        <h2>About ${esc(s.company_name || s.site_name)}</h2>
        <p style="color:var(--text-muted); margin-bottom:1.25rem;">${esc(s.site_tagline)}</p>
        <p>SocialAdLinker (<strong>https://www.socialadlinker.com</strong>) was built to replace frustrating, popup-heavy ad shorteners with a clean, direct micro-payment model powered by Razorpay.</p>
        <h3>Why We Built This</h3>
        <p>Traditional URL shorteners force visitors through confusing countdowns and misleading ads while paying creators pennies per thousand clicks. On SocialAdLinker, creators set a transparent whole-rupee unlock fee (starting at ₹1), visitors unlock the destination link immediately after paying via UPI or Card, and creators withdraw their collective earnings seamlessly.</p>
        <h3>Business &amp; Support Details</h3>
        <ul>
          <li><strong>Entity:</strong> ${esc(s.company_name || s.site_name)}</li>
          <li><strong>Support Email:</strong> ${esc(s.support_email)}</li>
          ${s.support_phone ? `<li><strong>Phone:</strong> ${esc(s.support_phone)}</li>` : ''}
          ${s.business_address ? `<li><strong>Address:</strong> ${esc(s.business_address)}</li>` : ''}
          ${s.grievance_officer ? `<li><strong>Grievance Officer:</strong> ${esc(s.grievance_officer)}</li>` : ''}
        </ul>
      </div>
    </section>
  `;
}

function renderContactPage() {
  const s = state.settings;
  return `
    <section class="section-container" style="max-width:780px;">
      <div class="card card-auth">
        <h2 style="font-size:1.65rem; font-weight:800; margin-bottom:0.35rem;">Contact Us</h2>
        <p style="color:var(--text-muted); margin-bottom:1.25rem;">
          Email us at <strong>${esc(s.support_email)}</strong>${s.support_phone ? ` or call <strong>${esc(s.support_phone)}</strong>` : ''}, or send a message below.
        </p>
        <form onsubmit="handleContactSubmit(event)">
          <div class="grid-2" style="gap:0.9rem;">
            <div class="form-group">
              <label class="form-label">Your Name</label>
              <input type="text" id="contactName" class="form-control" required />
            </div>
            <div class="form-group">
              <label class="form-label">Email Address</label>
              <input type="email" id="contactEmail" class="form-control" required />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Subject</label>
            <input type="text" id="contactSubject" class="form-control" required />
          </div>
          <div class="form-group">
            <label class="form-label">Message</label>
            <textarea id="contactMsg" rows="4" class="form-control" required minlength="10"></textarea>
          </div>
          <button type="submit" class="btn btn-primary btn-lg">Send Message</button>
        </form>
      </div>
    </section>
  `;
}

function renderTermsPage() {
  const s = state.settings;
  return `
    <section class="section-container">
      <div class="prose-card">
        <h2>Terms &amp; Conditions</h2>
        <p style="color:var(--text-muted);">Applies to ${esc(s.company_name || s.site_name)} (https://www.socialadlinker.com)</p>
        <h3>1. Platform Role</h3>
        <p>SocialAdLinker provides paid URL-shortening, payment collection via Razorpay, and creator payout settlement services. Creators are solely responsible for the legality, accuracy, and quality of the destination links they monetize.</p>
        <h3>2. Prohibited Content</h3>
        <p>You may not shorten or monetize links containing malware, phishing, copyrighted material without authorization, adult/explicit content, illegal goods, fraud, or deceptive claims. Violations result in immediate link blocking and account suspension.</p>
        <h3>3. Creator Pricing &amp; Payouts</h3>
        <p>Link prices must be whole-rupee integers starting at ₹${s.min_price_rupees}. Collective withdrawals are subject to the published platform commission (${s.withdrawal_commission_percent}%), minimum threshold (${fmtINR(s.min_withdrawal_rupees)}), and fraud/chargeback checks.</p>
        <h3>4. Contact</h3>
        <p>Questions regarding these terms may be sent to ${esc(s.support_email)}.</p>
      </div>
    </section>
  `;
}

function renderPrivacyPage() {
  const s = state.settings;
  return `
    <section class="section-container">
      <div class="prose-card">
        <h2>Privacy Policy</h2>
        <p style="color:var(--text-muted);">Effective for ${esc(s.company_name || s.site_name)} (https://www.socialadlinker.com)</p>
        <h3>1. Information We Collect</h3>
        <p>For creators, we store account details (username, email, password hash, payout details) and link analytics. For visitors unlocking links, we store an anonymous <code>httpOnly</code> session identifier cookie, hashed IP address, device type, and Razorpay payment/order identifiers strictly to prevent link bypass and handle support/refunds.</p>
        <h3>2. Payment Security</h3>
        <p>All payments are processed securely through Razorpay. SocialAdLinker does not store card numbers, CVVs, or UPI PINs.</p>
        <h3>3. Data Requests &amp; Grievance Officer</h3>
        <p>Contact ${esc(s.support_email)}${s.grievance_officer ? ` (Grievance Officer: ${esc(s.grievance_officer)})` : ''} for privacy or data deletion requests.</p>
      </div>
    </section>
  `;
}

function renderRefundPolicyPage() {
  const s = state.settings;
  return `
    <section class="section-container">
      <div class="prose-card">
        <h2>Cancellation &amp; Refund Policy</h2>
        <p>Because paid links grant immediate digital access to destination URLs upon payment verification, completed unlocks are generally non-refundable.</p>
        <h3>Eligible Refunds</h3>
        <ul>
          <li><strong>Duplicate Charge:</strong> If you were debited twice for the same link due to a network issue.</li>
          <li><strong>Broken or Misleading Link:</strong> If a creator's destination URL is dead, inaccessible, or violates our policies, report it within 48 hours via <a href="javascript:void(0)" onclick="navigate('report')">Report Abuse</a> or email <strong>${esc(s.support_email)}</strong> with your Razorpay Payment ID.</li>
        </ul>
        <p>Approved refunds are processed via Razorpay back to the original UPI/card payment method within 5–7 business days.</p>
      </div>
    </section>
  `;
}

function renderDeliveryPolicyPage() {
  const s = state.settings;
  return `
    <section class="section-container">
      <div class="prose-card">
        <h2>Digital Delivery Policy</h2>
        <p>${esc(s.company_name || s.site_name)} delivers purely digital URL access — no physical shipping applies.</p>
        <ul>
          <li><strong>Instant Fulfillment:</strong> Upon successful Razorpay payment verification, the destination link is unlocked immediately in your browser and remains accessible for ${s.unlock_validity_hours} hours (up to ${s.max_opens_per_payment} opens).</li>
          <li><strong>Issues Opening a Paid Link:</strong> Contact ${esc(s.support_email)} with the short link alias and your Razorpay Payment ID for immediate assistance.</li>
        </ul>
      </div>
    </section>
  `;
}

function renderReportPage() {
  const prefill = new URLSearchParams(window.location.search).get('alias') || '';
  return `
    <section class="section-container" style="max-width:640px;">
      <div class="card card-auth">
        <h2 style="font-size:1.55rem; font-weight:800; margin-bottom:0.35rem;">Report Abuse or Broken Paid Link</h2>
        <p style="color:var(--text-muted); margin-bottom:1.25rem;">If a short link violates our terms, is dead, or requires a refund investigation, submit it below.</p>
        <form onsubmit="handleAbuseReport(event)">
          <div class="form-group">
            <label class="form-label">Short Link or Alias</label>
            <input type="text" id="repAlias" class="form-control" value="${esc(prefill)}" placeholder="e.g. https://www.socialadlinker.com/abc123 or abc123" required />
          </div>
          <div class="form-group">
            <label class="form-label">Reason</label>
            <select id="repReason" class="form-control">
              <option value="scam">Misleading / Dead Link (Refund Request)</option>
              <option value="phishing">Phishing / Fraud</option>
              <option value="malware">Malware / Virus</option>
              <option value="copyright">Copyright / DMCA</option>
              <option value="adult">Adult / Prohibited Content</option>
              <option value="illegal">Illegal Content</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Details (include Razorpay Payment ID if requesting a refund)</label>
            <textarea id="repDetails" rows="4" class="form-control"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Your Email (for updates)</label>
            <input type="email" id="repEmail" class="form-control" placeholder="you@example.com" />
          </div>
          <button type="submit" class="btn btn-danger btn-lg">Submit Report</button>
        </form>
      </div>
    </section>
  `;
}

function renderLoginPage() {
  return `
    <section class="section-container" style="max-width:460px;">
      <div class="card card-auth">
        <h2 style="font-size:1.55rem; font-weight:800; margin-bottom:0.3rem;">Sign In to SocialAdLinker</h2>
        <p style="color:var(--text-muted); margin-bottom:1.4rem; font-size:0.92rem;">Access your Creator Dashboard, API keys, and payouts.</p>
        <form onsubmit="handleLogin(event)">
          <div class="form-group">
            <label class="form-label">Username or Email</label>
            <input type="text" id="loginId" class="form-control" required autocomplete="username" />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="loginPass" class="form-control" required autocomplete="current-password" />
          </div>
          <div style="text-align:right; margin-bottom:1rem; font-size:0.86rem;">
            <a href="javascript:void(0)" onclick="navigate('forgot-password')">Forgot password?</a>
          </div>
          <button type="submit" class="btn btn-primary btn-lg" style="width:100%;">Sign In</button>
        </form>
        <p style="text-align:center; font-size:0.9rem; color:var(--text-muted); margin-top:1.25rem;">
          Don't have an account? <a href="javascript:void(0)" onclick="navigate('register')">Create Creator Account</a>
        </p>
      </div>
    </section>
  `;
}

function renderRegisterPage() {
  const ref = localStorage.getItem('sal_ref') || '';
  return `
    <section class="section-container" style="max-width:500px;">
      <div class="card card-auth">
        <h2 style="font-size:1.55rem; font-weight:800; margin-bottom:0.3rem;">Create Creator Account</h2>
        <p style="color:var(--text-muted); margin-bottom:1.4rem; font-size:0.92rem;">Start monetizing your links with zero ads via Razorpay.</p>
        <form onsubmit="handleRegister(event)">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" id="regName" class="form-control" placeholder="Your full name" />
          </div>
          <div class="form-group">
            <label class="form-label">Username</label>
            <input type="text" id="regUser" class="form-control" placeholder="lowercase letters, numbers, _" required />
          </div>
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="regEmail" class="form-control" placeholder="you@example.com" required />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" id="regPass" class="form-control" placeholder="Min 8 chars, include letter &amp; number" required />
          </div>
          <div class="form-group">
            <label class="form-label">Referral Username (Optional)</label>
            <input type="text" id="regRef" class="form-control" value="${esc(ref)}" />
          </div>
          <label style="display:flex; align-items:flex-start; gap:0.55rem; font-size:0.86rem; color:#334155; margin-bottom:1.1rem; cursor:pointer;">
            <input type="checkbox" id="regTerms" required style="margin-top:0.25rem;" />
            <span>I agree to the <a href="javascript:void(0)" onclick="navigate('terms')">Terms of Service</a> and <a href="javascript:void(0)" onclick="navigate('privacy')">Privacy Policy</a>.</span>
          </label>
          <button type="submit" class="btn btn-emerald btn-lg" style="width:100%;">Create Account</button>
        </form>
        <p style="text-align:center; font-size:0.9rem; color:var(--text-muted); margin-top:1.25rem;">
          Already registered? <a href="javascript:void(0)" onclick="navigate('login')">Sign In</a>
        </p>
      </div>
    </section>
  `;
}

function renderForgotPage() {
  return `
    <section class="section-container" style="max-width:460px;">
      <div class="card card-auth">
        <h2 style="font-size:1.5rem; font-weight:800; margin-bottom:0.35rem;">Reset Password</h2>
        <p style="color:var(--text-muted); margin-bottom:1.25rem; font-size:0.92rem;">Enter your account email and we will send a 1-hour password reset link.</p>
        <form onsubmit="handleForgot(event)">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" id="forgotEmail" class="form-control" required />
          </div>
          <button type="submit" class="btn btn-primary btn-lg" style="width:100%;">Send Reset Link</button>
        </form>
      </div>
    </section>
  `;
}

function renderResetPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  return `
    <section class="section-container" style="max-width:460px;">
      <div class="card card-auth">
        <h2 style="font-size:1.5rem; font-weight:800; margin-bottom:0.35rem;">Choose a New Password</h2>
        <form onsubmit="handleResetPassword(event, '${esc(token)}')">
          <div class="form-group">
            <label class="form-label">New Password</label>
            <input type="password" id="resetPass" class="form-control" placeholder="Min 8 chars, include letter &amp; number" required />
          </div>
          <button type="submit" class="btn btn-emerald btn-lg" style="width:100%;">Update Password</button>
        </form>
      </div>
    </section>
  `;
}

function renderPublicFooter() {
  const s = state.settings;
  return `
    <footer class="public-footer">
      <div class="nav-container footer-top">
        <div style="max-width:340px;">
          <strong style="color:#ffffff; font-size:1.05rem;">${esc(s.company_name || s.site_name)}</strong>
          <p style="font-size:0.86rem; margin-top:0.45rem;">${esc(s.site_tagline)}</p>
          <p style="font-size:0.82rem; margin-top:0.45rem;">Support: ${esc(s.support_email)}</p>
        </div>
        <div class="footer-links">
          <span style="cursor:pointer" onclick="navigate('about')">About</span>
          <span style="cursor:pointer" onclick="navigate('pricing')">Pricing</span>
          <span style="cursor:pointer" onclick="navigate('developers')">API Docs</span>
          <span style="cursor:pointer" onclick="navigate('payment-proof')">Payouts</span>
          <span style="cursor:pointer" onclick="navigate('contact')">Contact</span>
          <span style="cursor:pointer" onclick="navigate('report')">Report Abuse</span>
          <span style="cursor:pointer" onclick="navigate('terms')">Terms</span>
          <span style="cursor:pointer" onclick="navigate('privacy')">Privacy</span>
          <span style="cursor:pointer" onclick="navigate('refund-policy')">Refund Policy</span>
          <span style="cursor:pointer" onclick="navigate('delivery-policy')">Delivery Policy</span>
        </div>
      </div>
      <div class="nav-container footer-bottom">
        <span>© ${new Date().getFullYear()} ${esc(s.company_name || s.site_name)} (https://www.socialadlinker.com). All rights reserved.</span>
        <span>Payments secured by Razorpay</span>
      </div>
    </footer>
  `;
}

// ============================================================================
// CREATOR DASHBOARD
// ============================================================================

function renderMemberShell() {
  const u = state.user;
  const s = state.settings;
  const nav = [
    { id: 'stats', icon: '📊', label: 'Overview & Analytics' },
    { id: 'links', icon: '🔗', label: 'Manage Links' },
    { id: 'mass', icon: '⚡', label: 'Mass Shrinker' },
    { id: 'withdraw', icon: '💸', label: 'Withdraw & Ledger' },
    { id: 'api', icon: '🔌', label: 'API & Webhooks' },
    { id: 'tools', icon: '🧰', label: 'Site Tools' },
    { id: 'referrals', icon: '👥', label: 'Referrals' },
    { id: 'settings', icon: '⚙️', label: 'Settings' },
    { id: 'support', icon: '🎫', label: 'Support' }
  ];

  let tabHtml = '';
  if (state.memberTab === 'stats') tabHtml = renderMemberStats();
  else if (state.memberTab === 'links') tabHtml = renderMemberLinks();
  else if (state.memberTab === 'mass') tabHtml = renderMemberMass();
  else if (state.memberTab === 'withdraw') tabHtml = renderMemberWithdraw();
  else if (state.memberTab === 'api') tabHtml = renderMemberApi();
  else if (state.memberTab === 'tools') tabHtml = renderMemberTools();
  else if (state.memberTab === 'referrals') tabHtml = renderMemberReferrals();
  else if (state.memberTab === 'settings') tabHtml = renderMemberSettings();
  else if (state.memberTab === 'support') tabHtml = renderMemberSupport();

  const last = state.lastCreatedLink;

  return `
    <div class="dashboard-layout">
      <div class="drawer-backdrop ${state.mobileSidebarOpen ? 'open' : ''}" onclick="closeMobileSidebar()"></div>

      <aside class="sidebar ${state.mobileSidebarOpen ? 'open' : ''}">
        <div class="sidebar-brand">
          <div class="brand-logo" style="font-size:1.15rem;" onclick="navigate('home')">
            <span class="brand-logo-icon" style="width:32px;height:32px;font-size:0.85rem;">SA</span>
            <span>${esc(s.site_name)}</span>
          </div>
          <button type="button" class="sidebar-close-btn" aria-label="Close sidebar menu" onclick="closeMobileSidebar()">✕</button>
        </div>

        <div class="sidebar-user-card">
          <div style="font-size:0.74rem; color:#94a3b8; text-transform:uppercase;">Available Balance</div>
          <div style="font-size:1.45rem; font-weight:800; color:#34d399; margin:0.15rem 0;">${fmtINR(u.balance_rupees)}</div>
          <div style="font-size:0.8rem; color:#cbd5e1;">@${esc(u.username)} • Default: <strong>₹${u.default_price_rupees}/link</strong></div>
        </div>

        <nav class="sidebar-nav">
          ${nav.map((n) => `
            <div class="sidebar-item ${state.memberTab === n.id ? 'active' : ''}" onclick="switchMemberTab('${n.id}')">
              <span>${n.icon}</span><span>${n.label}</span>
            </div>
          `).join('')}
          ${u.role === 'admin' ? `
            <div style="margin-top:0.65rem; padding-top:0.65rem; border-top:1px solid rgba(255,255,255,0.08);">
              <div class="sidebar-item" style="color:#fbbf24;" onclick="navigate('admin', 'overview')">
                <span>🛡️</span><span>Admin Panel</span>
              </div>
            </div>
          ` : ''}
        </nav>

        <div style="padding:1rem; border-top:1px solid rgba(255,255,255,0.07); display:flex; flex-direction:column; gap:0.5rem;">
          <button class="btn btn-sm btn-ghost-light" onclick="navigate('home')">Public Site</button>
          <button class="btn btn-sm btn-danger" onclick="logout()">Logout</button>
        </div>
      </aside>

      <div class="dashboard-main">
        <div class="mobile-dash-header">
          <div class="mobile-dash-left">
            <button type="button" class="mobile-dash-menu-btn" aria-label="Open dashboard menu" onclick="toggleMobileSidebar()">☰</button>
            <span class="mobile-dash-title">${esc(s.site_name)}</span>
          </div>
          <span class="mobile-dash-pill" onclick="switchMemberTab('withdraw')">Wallet: ${fmtINR(u.balance_rupees)}</span>
        </div>

        <div class="mobile-tab-strip">
          ${nav.map((n) => `
            <button type="button" class="mobile-tab-pill ${state.memberTab === n.id ? 'active' : ''}" onclick="switchMemberTab('${n.id}')">
              <span>${n.icon}</span><span>${n.label}</span>
            </button>
          `).join('')}
        </div>

        <div class="dashboard-topbar">
          <form class="quick-shortener-bar" onsubmit="handleQuickShorten(event)">
            <input type="url" id="quickUrl" class="form-control" placeholder="Paste destination URL to monetize (https://...)" required />
            <input type="text" id="quickAlias" class="form-control" placeholder="Alias (optional)" />
            <div class="price-input-wrapper">
              <span class="price-prefix">₹</span>
              <input type="number" id="quickPrice" class="form-control" style="padding-left:1.9rem;" min="${s.min_price_rupees}" max="${s.max_price_rupees}" step="1" value="${u.default_price_rupees}" title="Whole rupees only (1, 2, 3...)" required />
            </div>
            <button type="submit" class="btn btn-primary">Shorten &amp; Price</button>
          </form>

          ${last ? `
            <div style="margin-top:0.75rem; padding:0.75rem 1rem; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:10px; display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap;">
              <div style="min-width:0;">
                <span class="badge badge-success">₹${last.price_rupees} / unlock</span>
                <strong class="break-all" style="margin-left:0.5rem;">${esc(last.short_url)}</strong>
              </div>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <button class="btn btn-sm btn-outline" onclick="copyText('${esc(last.short_url)}')">Copy Link</button>
                <a href="/${esc(last.alias)}" target="_blank" class="btn btn-sm btn-emerald">Open Gate ↗</a>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="dashboard-content">${tabHtml}</div>
      </div>
    </div>
  `;
}

async function switchMemberTab(tab) {
  state.mobileSidebarOpen = false;
  await loadMemberTab(tab);
  render();
}

function renderRevenueSvg(rows, valKey, color = '#4f46e5') {
  const max = Math.max(10, ...rows.map((r) => Number(r[valKey]) || 0));
  const w = 740;
  const h = 180;
  const barW = 32;
  const gap = (w - 50) / Math.max(1, rows.length);
  return `
    <div class="chart-scroll">
      <svg viewBox="0 0 ${w} ${h + 32}" class="revenue-svg">
        ${rows.map((r, idx) => {
          const val = Number(r[valKey]) || 0;
          const bh = Math.max(4, Math.round((val / max) * (h - 28)));
          const x = 28 + idx * gap;
          const y = h - bh;
          const label = String(r.day).slice(5);
          return `<g>
            <rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="5" fill="${color}" opacity="0.9"></rect>
            ${val > 0 ? `<text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" font-weight="700" fill="#1e293b">₹${val}</text>` : ''}
            <text x="${x + barW / 2}" y="${h + 18}" text-anchor="middle" font-size="10" fill="#64748b">${esc(label)}</text>
          </g>`;
        }).join('')}
      </svg>
    </div>
  `;
}

function renderMemberStats() {
  const d = state.dashboard;
  if (!d) return '<div class="card">Loading dashboard...</div>';
  const sum = d.summary;
  return `
    ${state.settings.announcement ? `
      <div class="announcement-box">
        <div style="font-size:1.3rem;">📢</div>
        <div><strong>Notice:</strong> ${esc(state.settings.announcement)}</div>
      </div>
    ` : ''}

    <div class="kpi-grid">
      <div class="kpi-card emerald">
        <div class="kpi-label">Available Wallet</div>
        <div class="kpi-value">${fmtINR(d.user.balance_rupees)}</div>
        <div class="kpi-sub">Pending: ${fmtINR(d.user.pending_withdrawal_rupees)} • Withdrawn: ${fmtINR(d.user.total_withdrawn_rupees)}</div>
      </div>
      <div class="kpi-card indigo">
        <div class="kpi-label">Paid Razorpay Unlocks</div>
        <div class="kpi-value">${sum.total_unlocks.toLocaleString('en-IN')}</div>
        <div class="kpi-sub">Across ${sum.total_clicks.toLocaleString('en-IN')} visits</div>
      </div>
      <div class="kpi-card cyan">
        <div class="kpi-label">Lifetime Earnings</div>
        <div class="kpi-value">${fmtINR(d.user.lifetime_earned_rupees)}</div>
        <div class="kpi-sub">Default: ₹${d.user.default_price_rupees}/link (${fmtINR(sum.effective_cpm_rupees)} CPM)</div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-label">Active Links</div>
        <div class="kpi-value">${sum.total_links}</div>
        <div class="kpi-sub">Referral earned: ${fmtINR(d.user.referral_earned_rupees)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Last 14 Days Revenue (IST)</div>
        <span class="badge badge-success">Razorpay Verified Unlocks</span>
      </div>
      ${renderRevenueSvg(d.daily, 'earned_rupees')}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><div class="card-title">Top Performing Links</div></div>
        <div class="table-responsive">
          <table>
            <thead><tr><th>Link</th><th>Price</th><th>Unlocks</th><th>Earned</th></tr></thead>
            <tbody>
              ${d.top_links.length === 0 ? '<tr><td colspan="4" style="color:var(--text-muted);">No links yet.</td></tr>' : d.top_links.map((l) => `
                <tr>
                  <td><a href="/${esc(l.alias)}" target="_blank">/${esc(l.alias)}</a><div style="font-size:0.78rem;color:var(--text-muted);">${esc(l.title)}</div></td>
                  <td>₹${l.price_rupees}</td>
                  <td>${l.unlocks} / ${l.clicks}</td>
                  <td><strong style="color:var(--emerald-dark);">${fmtINR(l.earned_rupees)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Paid Unlocks</div></div>
        <div class="table-responsive">
          <table>
            <thead><tr><th>Alias</th><th>Paid</th><th>Device / Source</th><th>Razorpay ID</th></tr></thead>
            <tbody>
              ${d.recent_payments.length === 0 ? '<tr><td colspan="4" style="color:var(--text-muted);">No paid unlocks yet.</td></tr>' : d.recent_payments.map((p) => `
                <tr>
                  <td>/${esc(p.alias)}</td>
                  <td><span class="badge badge-success">₹${p.amount_rupees}</span></td>
                  <td>${esc(p.device)} • ${esc(p.referrer_host)}</td>
                  <td><code>${esc(p.rzp_payment_id)}</code></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderMemberLinks() {
  return `
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Manage Protected Links</div>
          <div style="font-size:0.84rem; color:var(--text-muted);">Edit whole-rupee prices, pause links, or test the Razorpay gate.</div>
        </div>
        <div class="filter-controls">
          <input type="text" id="linksSearchInput" class="form-control filter-input" value="${esc(state.linksSearch)}" placeholder="Search alias/title/URL..." oninput="searchMemberLinks(this.value)" />
          <select class="form-control filter-select" onchange="state.linksStatus=this.value; switchMemberTab('links');">
            <option value="" ${state.linksStatus === '' ? 'selected' : ''}>All Status</option>
            <option value="active" ${state.linksStatus === 'active' ? 'selected' : ''}>Active</option>
            <option value="paused" ${state.linksStatus === 'paused' ? 'selected' : ''}>Paused</option>
            <option value="blocked" ${state.linksStatus === 'blocked' ? 'selected' : ''}>Blocked</option>
          </select>
        </div>
      </div>

      <div class="table-responsive">
        <table>
          <thead><tr><th>Link &amp; Destination</th><th>Price</th><th>Visits / Paid</th><th>Earned</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.links.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No links found.</td></tr>' : state.links.map((l) => `
              <tr>
                <td>
                  <strong>${esc(l.title || l.alias)}</strong>
                  ${l.external_ref ? `<span class="badge badge-neutral" style="margin-left:0.35rem;">ref: ${esc(l.external_ref)}</span>` : ''}
                  <div><a href="/${esc(l.alias)}" target="_blank">${esc(l.short_url)}</a></div>
                  <div style="font-size:0.76rem; color:var(--text-muted); max-width:min(320px, 58vw); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">→ ${esc(l.destination_url)}</div>
                </td>
                <td><span class="badge badge-indigo">₹${l.price_rupees}/click</span></td>
                <td>${l.clicks} / <strong>${l.unlocks}</strong></td>
                <td><strong style="color:var(--emerald-dark);">${fmtINR(l.earned_rupees)}</strong></td>
                <td><span class="badge ${l.status === 'active' ? 'badge-success' : l.status === 'blocked' ? 'badge-danger' : 'badge-warning'}">${esc(l.status)}</span></td>
                <td>
                  <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
                    <button class="btn btn-sm btn-outline" onclick="copyText('${esc(l.short_url)}')">Copy</button>
                    <button class="btn btn-sm btn-primary" onclick="openEditLinkModal('${esc(l.alias)}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteLink('${esc(l.alias)}')">Delete</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderMemberMass() {
  const s = state.settings;
  return `
    <div class="card" style="max-width:860px;">
      <div class="card-header"><div class="card-title">Mass URL Shrinker (Up to 25 URLs)</div></div>
      <form onsubmit="handleMassShrink(event)">
        <div class="form-group">
          <label class="form-label">Destination URLs (one per line)</label>
          <textarea id="massUrls" rows="6" class="form-control" placeholder="https://example.com/file1&#10;https://example.com/file2" required></textarea>
        </div>
        <div style="display:flex; gap:0.85rem; align-items:flex-end; flex-wrap:wrap;">
          <div class="form-group" style="margin-bottom:0; flex: 1 1 220px; max-width:100%;">
            <label class="form-label">Price Per Link (Whole ₹ ≥ ${s.min_price_rupees})</label>
            <input type="number" id="massPrice" class="form-control" min="${s.min_price_rupees}" max="${s.max_price_rupees}" step="1" value="${state.user.default_price_rupees}" required />
          </div>
          <button type="submit" class="btn btn-emerald">Shorten Batch</button>
        </div>
      </form>
      ${state.massResults ? `
        <div style="margin-top:1.25rem;">
          <div style="font-weight:700; margin-bottom:0.45rem;">Created ${state.massResults.created.length} Links:</div>
          <div class="code-block">${esc(state.massResults.created.map((l) => `${l.short_url}  (₹${l.price_rupees}) -> ${l.destination_url}`).join('\n'))}</div>
          ${state.massResults.errors.length ? `<div style="margin-top:0.75rem; color:var(--rose); font-size:0.86rem;">Skipped ${state.massResults.errors.length} invalid URL(s).</div>` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderMemberWithdraw() {
  const u = state.user;
  const s = state.settings;
  const commPct = s.withdrawal_commission_percent;
  const minW = s.min_withdrawal_rupees;
  const defAmt = u.balance_rupees >= minW ? u.balance_rupees : minW;

  return `
    <div class="kpi-grid">
      <div class="kpi-card emerald">
        <div class="kpi-label">Available Balance</div>
        <div class="kpi-value">${fmtINR(u.balance_rupees)}</div>
        <div class="kpi-sub">Minimum withdrawal: ${fmtINR(minW)}</div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-label">Pending Withdrawal</div>
        <div class="kpi-value">${fmtINR(u.pending_withdrawal_rupees)}</div>
        <div class="kpi-sub">Queued for payout</div>
      </div>
      <div class="kpi-card indigo">
        <div class="kpi-label">Total Paid Out</div>
        <div class="kpi-value">${fmtINR(u.total_withdrawn_rupees)}</div>
        <div class="kpi-sub">Platform commission: ${commPct}%</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Request Collective Withdrawal</div>
        <span class="badge badge-indigo">Platform Fee: ${commPct}%</span>
      </div>
      <form onsubmit="handleWithdrawSubmit(event)">
        <div class="grid-2" style="gap:1rem;">
          <div class="form-group">
            <label class="form-label">Amount (₹)</label>
            <input type="number" id="wdAmount" class="form-control" min="${minW}" step="0.01" value="${defAmt}" oninput="updateWdPreview()" required />
          </div>
          <div class="form-group">
            <label class="form-label">Payout Method</label>
            <select id="wdMethod" class="form-control" onchange="toggleWdFields()">
              <option value="upi" ${u.payout_method === 'upi' ? 'selected' : ''}>UPI (Instant Settlement)</option>
              <option value="bank" ${u.payout_method === 'bank' ? 'selected' : ''}>Bank Transfer (IMPS / NEFT)</option>
            </select>
          </div>
        </div>

        <div id="wdUpiFields" style="display:${u.payout_method === 'bank' ? 'none' : 'block'};">
          <div class="form-group">
            <label class="form-label">UPI ID</label>
            <input type="text" id="wdUpi" class="form-control" value="${esc(u.upi_id)}" placeholder="yourname@okaxis" />
          </div>
        </div>

        <div id="wdBankFields" style="display:${u.payout_method === 'bank' ? 'grid' : 'none'}; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1rem;">
          <div class="form-group">
            <label class="form-label">Account Holder Name</label>
            <input type="text" id="wdBankName" class="form-control" value="${esc(u.bank_account_name)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Account Number</label>
            <input type="text" id="wdBankAcc" class="form-control" placeholder="${u.bank_account_number_masked ? 'Saved: ' + esc(u.bank_account_number_masked) : '9-18 digits'}" />
          </div>
          <div class="form-group">
            <label class="form-label">IFSC Code</label>
            <input type="text" id="wdBankIfsc" class="form-control" value="${esc(u.bank_ifsc)}" placeholder="HDFC0001234" />
          </div>
        </div>

        <div id="wdPreview" style="background:#f8fafc; border:1px solid var(--border); border-radius:9px; padding:0.8rem 1rem; font-size:0.88rem; margin-bottom:1rem;">
          Gross: <strong>${fmtINR(defAmt)}</strong> − Commission (${commPct}%): <strong>${fmtINR(+(defAmt * commPct / 100).toFixed(2))}</strong> =
          <strong style="color:var(--emerald-dark);">Net Payable: ${fmtINR(+(defAmt - defAmt * commPct / 100).toFixed(2))}</strong>
        </div>

        <button type="submit" class="btn btn-emerald" ${u.balance_rupees < minW ? 'disabled' : ''}>Submit Withdrawal Request</button>
      </form>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Withdrawal History</div></div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>ID</th><th>Date</th><th>Gross</th><th>Fee</th><th>Net Paid</th><th>Method</th><th>Status</th><th>UTR</th></tr></thead>
          <tbody>
            ${state.withdrawals.length === 0 ? '<tr><td colspan="8" style="color:var(--text-muted);">No withdrawals yet.</td></tr>' : state.withdrawals.map((w) => `
              <tr>
                <td>#${w.id}</td>
                <td>${fmtDate(w.created_at)}</td>
                <td>${fmtINR(w.gross_rupees)}</td>
                <td>${w.commission_percent}% (${fmtINR(w.commission_rupees)})</td>
                <td><strong style="color:var(--emerald-dark);">${fmtINR(w.net_rupees)}</strong></td>
                <td>${esc(w.method.toUpperCase())}</td>
                <td><span class="badge ${w.status === 'paid' ? 'badge-success' : w.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">${esc(w.status)}</span></td>
                <td><code>${esc(w.utr || w.admin_note || '-')}</code></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Immutable Wallet Ledger</div></div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance After</th><th>Note</th></tr></thead>
          <tbody>
            ${state.ledger.length === 0 ? '<tr><td colspan="5" style="color:var(--text-muted);">No ledger entries yet.</td></tr>' : state.ledger.map((e) => `
              <tr>
                <td>${fmtDate(e.created_at)}</td>
                <td><span class="badge badge-neutral">${esc(e.entry_type)}</span></td>
                <td><strong style="color:${e.amount_rupees >= 0 ? 'var(--emerald-dark)' : 'var(--rose)'};">${e.amount_rupees >= 0 ? '+' : ''}${fmtINR(e.amount_rupees)}</strong></td>
                <td>${fmtINR(e.balance_after_rupees)}</td>
                <td>${esc(e.note)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function toggleWdFields() {
  const m = document.getElementById('wdMethod').value;
  document.getElementById('wdUpiFields').style.display = m === 'upi' ? 'block' : 'none';
  document.getElementById('wdBankFields').style.display = m === 'bank' ? 'grid' : 'none';
}

function updateWdPreview() {
  const amt = Number(document.getElementById('wdAmount')?.value) || 0;
  const pct = state.settings.withdrawal_commission_percent;
  const comm = +(amt * pct / 100).toFixed(2);
  const net = +(amt - comm).toFixed(2);
  const el = document.getElementById('wdPreview');
  if (el) el.innerHTML = `Gross: <strong>${fmtINR(amt)}</strong> − Commission (${pct}%): <strong>${fmtINR(comm)}</strong> = <strong style="color:var(--emerald-dark);">Net Payable: ${fmtINR(net)}</strong>`;
}

function renderMemberApi() {
  const u = state.user;
  const origin = window.location.origin;
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Secret Developer API Key (For Telegram Bots &amp; Servers)</div>
        <button class="btn btn-sm btn-primary" onclick="regenApiKey()">${u.has_api_key ? 'Regenerate API Key' : 'Generate API Key'}</button>
      </div>
      ${state.revealedApiKey ? `
        <div style="background:#ecfdf5; border:1px solid #10b981; padding:1rem; border-radius:10px; margin-bottom:1rem;">
          <div style="font-weight:700; color:#065f46; margin-bottom:0.4rem;">Copy your new API key now — for security, it will never be shown in full again:</div>
          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
            <code class="break-all" style="font-size:0.92rem; padding:0.4rem 0.7rem;">${esc(state.revealedApiKey)}</code>
            <button class="btn btn-sm btn-emerald" onclick="copyText('${esc(state.revealedApiKey)}', 'Secret API Key copied!')">Copy Key</button>
          </div>
        </div>
      ` : `
        <p style="color:var(--text-muted); margin-bottom:0.85rem;">
          ${u.has_api_key ? `Active key prefix: <code>${esc(u.api_key_prefix)}••••••••••••••••</code>` : 'No secret API key generated yet. Click "Generate API Key" to start.'}
        </p>
      `}
      <div class="code-block">POST ${origin}/api/v1/links
Authorization: Bearer ${esc(state.revealedApiKey || 'sal_sk_YOUR_API_KEY')}
Content-Type: application/json

{"url": "https://example.com/resource", "price": ${u.default_price_rupees}, "ref": "tg_chat_123"}</div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">Payment Webhooks (Real-time Notification on Paid Unlocks)</div>
        ${u.webhook_url ? `<button class="btn btn-sm btn-outline" onclick="testCreatorWebhook()">Send Test Webhook</button>` : ''}
      </div>
      <form onsubmit="saveCreatorWebhook(event)">
        <div class="form-group">
          <label class="form-label">HTTPS Webhook Endpoint URL</label>
          <input type="url" id="whUrlInput" class="form-control" value="${esc(u.webhook_url)}" placeholder="https://yourbot.example.com/webhooks/socialadlinker" />
          <div class="form-hint">We POST signed <code>payment.paid</code> events with <code>X-SAL-Signature</code> whenever a user unlocks your link.</div>
        </div>
        <div style="display:flex; gap:0.65rem; flex-wrap:wrap;">
          <button type="submit" class="btn btn-primary">Save Webhook URL</button>
          ${u.webhook_url ? `<button type="button" class="btn btn-outline" onclick="revealWebhookSecret()">Reveal Signing Secret</button>` : ''}
        </div>
      </form>
      ${state.revealedWebhookSecret ? `
        <div style="margin-top:0.9rem; background:#f8fafc; border:1px solid var(--border); padding:0.85rem; border-radius:9px; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <strong>Webhook Signing Secret:</strong> <code class="break-all">${esc(state.revealedWebhookSecret)}</code>
          <button class="btn btn-sm btn-outline" onclick="copyText('${esc(state.revealedWebhookSecret)}')">Copy</button>
        </div>
      ` : ''}

      ${state.webhookDeliveries.length > 0 ? `
        <h4 style="margin:1.25rem 0 0.65rem; font-size:0.95rem;">Recent Webhook Deliveries</h4>
        <div class="table-responsive">
          <table>
            <thead><tr><th>Time</th><th>Event</th><th>Status</th><th>HTTP</th><th>Attempts</th><th>Error</th></tr></thead>
            <tbody>
              ${state.webhookDeliveries.map((d) => `
                <tr>
                  <td>${fmtDate(d.created_at)}</td>
                  <td><code>${esc(d.event)}</code></td>
                  <td><span class="badge ${d.status === 'delivered' ? 'badge-success' : d.status === 'failed' ? 'badge-danger' : 'badge-warning'}">${esc(d.status)}</span></td>
                  <td>${d.last_status || '-'}</td>
                  <td>${d.attempts}</td>
                  <td style="font-size:0.8rem; color:var(--text-muted);">${esc(d.last_error || '-')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
    </div>
  `;
}

function renderMemberTools() {
  const u = state.user;
  const origin = window.location.origin;
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Quick Link Generator (Uses Your Safe Public Key)</div></div>
      <p style="color:var(--text-muted); font-size:0.88rem; margin-bottom:0.75rem;">
        Safe to embed in websites or share — uses your public key (<code>${esc(u.public_key)}</code>), never your secret key.
      </p>
      <div class="code-block">${origin}/st?pk=${esc(u.public_key)}&amp;url=https://example.com/file&amp;price=${u.default_price_rupees}</div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Full-Page Link Monetizer Script (For Blogs &amp; Download Sites)</div></div>
      <div class="code-block">&lt;script&gt;
  window.sal_public_key = '${esc(u.public_key)}';
  window.sal_price_rupees = ${u.default_price_rupees};
  window.sal_exclude_domains = ['google.com', 'youtube.com'];
&lt;/script&gt;
&lt;script src="${origin}/js/full-page-script.js"&gt;&lt;/script&gt;</div>
    </div>
  `;
}

function renderMemberReferrals() {
  const r = state.referrals || { referral_url: '', referral_percent: 0, referral_earned_rupees: 0, referred_users: [] };
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Creator Referral Program (${r.referral_percent}% Bonus)</div></div>
      <p style="color:var(--text-muted); margin-bottom:1rem;">
        ${r.referral_percent > 0 ? `Earn a ${r.referral_percent}% platform-funded bonus whenever creators you invite earn from unlocks.` : 'Share your invite link below. Platform referral bonus percentage is controlled by Admin Settings.'}
      </p>
      <div style="display:flex; gap:0.65rem; flex-wrap:wrap; margin-bottom:1.25rem;">
        <input type="text" class="form-control" style="flex:1 1 240px; max-width:480px;" value="${esc(r.referral_url)}" readonly />
        <button class="btn btn-primary" onclick="copyText('${esc(r.referral_url)}', 'Referral link copied!')">Copy Invite Link</button>
      </div>
      <p style="margin-bottom:1rem;">Total Referral Earnings: <strong>${fmtINR(r.referral_earned_rupees)}</strong> • Referred Creators: <strong>${r.referred_users.length}</strong></p>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Username</th><th>Joined</th></tr></thead>
          <tbody>
            ${r.referred_users.length === 0 ? '<tr><td colspan="2" style="color:var(--text-muted);">No referred creators yet.</td></tr>' : r.referred_users.map((u) => `
              <tr><td>@${esc(u.username)}</td><td>${fmtDate(u.created_at)}</td></tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderMemberSettings() {
  const u = state.user;
  const s = state.settings;
  return `
    <div class="card" style="max-width:740px;">
      <div class="card-header"><div class="card-title">Pricing, Payout &amp; Account Settings</div></div>
      <form onsubmit="saveMemberSettings(event)">
        <div class="form-group">
          <label class="form-label">Default Price Per Link (Whole ₹ Only: ${s.min_price_rupees} to ${s.max_price_rupees})</label>
          <input type="number" id="setDefPrice" class="form-control" min="${s.min_price_rupees}" max="${s.max_price_rupees}" step="1" value="${u.default_price_rupees}" required />
          <div class="form-hint">Effective CPM at ₹${u.default_price_rupees}/link = <strong>${fmtINR(u.default_price_rupees * 1000)}</strong> per 1,000 unlocks.</div>
        </div>
        <div class="grid-2" style="gap:1rem;">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" id="setFullName" class="form-control" value="${esc(u.full_name)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Phone</label>
            <input type="text" id="setPhone" class="form-control" value="${esc(u.phone)}" />
          </div>
        </div>
        <div class="grid-2" style="gap:1rem;">
          <div class="form-group">
            <label class="form-label">Preferred Payout Method</label>
            <select id="setPayMethod" class="form-control">
              <option value="upi" ${u.payout_method === 'upi' ? 'selected' : ''}>UPI</option>
              <option value="bank" ${u.payout_method === 'bank' ? 'selected' : ''}>Bank Transfer</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">UPI ID</label>
            <input type="text" id="setUpi" class="form-control" value="${esc(u.upi_id)}" placeholder="name@okaxis" />
          </div>
        </div>
        <div class="grid-3" style="gap:0.85rem;">
          <div class="form-group">
            <label class="form-label">Bank Account Name</label>
            <input type="text" id="setBankName" class="form-control" value="${esc(u.bank_account_name)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Bank Account Number</label>
            <input type="text" id="setBankAcc" class="form-control" placeholder="${u.bank_account_number_masked ? 'Saved: ' + esc(u.bank_account_number_masked) : ''}" />
          </div>
          <div class="form-group">
            <label class="form-label">IFSC Code</label>
            <input type="text" id="setIfsc" class="form-control" value="${esc(u.bank_ifsc)}" placeholder="HDFC0001234" />
          </div>
        </div>
        <hr style="margin:1.25rem 0; border:none; border-top:1px solid var(--border);" />
        <div class="grid-2" style="gap:1rem;">
          <div class="form-group">
            <label class="form-label">Current Password (only to change password)</label>
            <input type="password" id="setCurrPass" class="form-control" />
          </div>
          <div class="form-group">
            <label class="form-label">New Password</label>
            <input type="password" id="setNewPass" class="form-control" placeholder="Min 8 chars, letter + number" />
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Save Settings</button>
      </form>
    </div>
  `;
}

function renderMemberSupport() {
  return `
    <div class="card" style="max-width:740px;">
      <div class="card-header"><div class="card-title">Open a Support Ticket</div></div>
      <form onsubmit="createTicket(event)">
        <div class="grid-2" style="gap:0.85rem;">
          <div class="form-group">
            <label class="form-label">Subject</label>
            <input type="text" id="tSubject" class="form-control" required />
          </div>
          <div class="form-group">
            <label class="form-label">Category</label>
            <select id="tCat" class="form-control">
              <option value="payouts">Payouts &amp; Withdrawals</option>
              <option value="razorpay">Razorpay Payments</option>
              <option value="api">API &amp; Webhooks</option>
              <option value="general">General</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Message</label>
          <textarea id="tMsg" rows="3" class="form-control" required minlength="10"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Submit Ticket</button>
      </form>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Your Tickets</div></div>
      ${state.tickets.length === 0 ? '<p style="color:var(--text-muted);">No support tickets yet.</p>' : state.tickets.map((t) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:1rem; margin-bottom:0.85rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.35rem; flex-wrap:wrap; gap:0.45rem;">
            <strong>#${t.id} — ${esc(t.subject)}</strong>
            <span class="badge ${t.status === 'answered' ? 'badge-success' : t.status === 'closed' ? 'badge-neutral' : 'badge-warning'}">${esc(t.status)}</span>
          </div>
          <p style="font-size:0.9rem; color:var(--text-muted);">${esc(t.message)}</p>
          ${t.admin_reply ? `<div style="margin-top:0.6rem; padding:0.75rem; background:#eef2ff; border-radius:8px; font-size:0.88rem;"><strong>Admin:</strong> ${esc(t.admin_reply)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================================
// ADMIN PANEL
// ============================================================================

function renderAdminShell() {
  const nav = [
    { id: 'overview', icon: '📈', label: 'Overview' },
    { id: 'withdrawals', icon: '💸', label: 'Withdrawals' },
    { id: 'payments', icon: '💳', label: 'Payments & Refunds' },
    { id: 'users', icon: '👥', label: 'Creators & Users' },
    { id: 'links', icon: '🔗', label: 'Links Moderation' },
    { id: 'reports', icon: '🚨', label: 'Abuse & Inbox' },
    { id: 'tickets', icon: '🎫', label: 'Tickets' },
    { id: 'settings', icon: '⚙️', label: 'Platform & KYC Settings' },
    { id: 'logs', icon: '📜', label: 'Audit Logs' }
  ];

  let tabHtml = '';
  if (state.adminTab === 'overview') tabHtml = renderAdminOverview();
  else if (state.adminTab === 'withdrawals') tabHtml = renderAdminWithdrawals();
  else if (state.adminTab === 'payments') tabHtml = renderAdminPayments();
  else if (state.adminTab === 'users') tabHtml = renderAdminUsers();
  else if (state.adminTab === 'links') tabHtml = renderAdminLinks();
  else if (state.adminTab === 'reports') tabHtml = renderAdminReports();
  else if (state.adminTab === 'tickets') tabHtml = renderAdminTickets();
  else if (state.adminTab === 'settings') tabHtml = renderAdminSettings();
  else if (state.adminTab === 'logs') tabHtml = renderAdminLogs();

  return `
    <div class="dashboard-layout">
      <div class="drawer-backdrop ${state.mobileSidebarOpen ? 'open' : ''}" onclick="closeMobileSidebar()"></div>

      <aside class="sidebar ${state.mobileSidebarOpen ? 'open' : ''}">
        <div class="sidebar-brand">
          <div class="brand-logo" style="font-size:1.15rem;" onclick="navigate('home')">
            <span class="brand-logo-icon" style="width:32px;height:32px;background:linear-gradient(135deg,#f59e0b,#ef4444);">AD</span>
            <span>Admin Console</span>
          </div>
          <button type="button" class="sidebar-close-btn" aria-label="Close admin sidebar" onclick="closeMobileSidebar()">✕</button>
        </div>
        <div class="sidebar-user-card">
          <div style="font-size:0.74rem; color:#fbbf24; font-weight:700; text-transform:uppercase;">SocialAdLinker Admin</div>
          <div style="font-size:0.9rem; color:#fff;">@${esc(state.user.username)}</div>
          <div style="font-size:0.76rem; color:#94a3b8;">Commission: ${state.settings.withdrawal_commission_percent}%</div>
        </div>
        <nav class="sidebar-nav">
          ${nav.map((n) => `
            <div class="sidebar-item ${state.adminTab === n.id ? 'active' : ''}" onclick="switchAdminTab('${n.id}')">
              <span>${n.icon}</span><span>${n.label}</span>
            </div>
          `).join('')}
          <div style="margin-top:0.65rem; padding-top:0.65rem; border-top:1px solid rgba(255,255,255,0.08);">
            <div class="sidebar-item" style="color:#34d399;" onclick="navigate('member', 'stats')">
              <span>📊</span><span>Creator Dashboard</span>
            </div>
          </div>
        </nav>
        <div style="padding:1rem; border-top:1px solid rgba(255,255,255,0.07); display:flex; flex-direction:column; gap:0.5rem;">
          <button class="btn btn-sm btn-ghost-light" onclick="navigate('home')">Public Site</button>
          <button class="btn btn-sm btn-danger" onclick="logout()">Logout</button>
        </div>
      </aside>
      <div class="dashboard-main">
        <div class="mobile-dash-header">
          <div class="mobile-dash-left">
            <button type="button" class="mobile-dash-menu-btn" aria-label="Open admin menu" onclick="toggleMobileSidebar()">☰</button>
            <span class="mobile-dash-title">Admin Console</span>
          </div>
          <span class="mobile-dash-pill admin" onclick="switchAdminTab('settings')">Fee: ${state.settings.withdrawal_commission_percent}%</span>
        </div>

        <div class="mobile-tab-strip">
          ${nav.map((n) => `
            <button type="button" class="mobile-tab-pill ${state.adminTab === n.id ? 'active' : ''}" onclick="switchAdminTab('${n.id}')">
              <span>${n.icon}</span><span>${n.label}</span>
            </button>
          `).join('')}
        </div>

        <div class="dashboard-topbar" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">
          <strong>${esc(state.settings.site_name)} — Production Administration</strong>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <span class="badge ${state.paymentsEnabled ? 'badge-success' : 'badge-danger'}">${state.paymentsEnabled ? 'Razorpay Keys Active' : 'Razorpay Keys Missing'}</span>
            <button class="btn btn-sm btn-outline" onclick="switchAdminTab('settings')">Commission: ${state.settings.withdrawal_commission_percent}%</button>
          </div>
        </div>
        <div class="dashboard-content">${tabHtml}</div>
      </div>
    </div>
  `;
}

async function switchAdminTab(tab) {
  state.mobileSidebarOpen = false;
  await loadAdminTab(tab);
  render();
}

function renderAdminOverview() {
  const ov = state.adminOverview;
  if (!ov) return '<div class="card">Loading admin overview...</div>';
  const k = ov.kpis;
  return `
    <div class="kpi-grid">
      <div class="kpi-card indigo">
        <div class="kpi-label">Gross Razorpay Volume</div>
        <div class="kpi-value">${fmtINR(k.gross_revenue_rupees)}</div>
        <div class="kpi-sub">${k.paid_unlocks} unlocks across ${k.links} links</div>
      </div>
      <div class="kpi-card emerald">
        <div class="kpi-label">Commission Realized</div>
        <div class="kpi-value">${fmtINR(k.realized_commission_rupees)}</div>
        <div class="kpi-sub">Paid out: ${fmtINR(k.completed_payouts_rupees)}</div>
      </div>
      <div class="kpi-card amber">
        <div class="kpi-label">Pending Payouts Due</div>
        <div class="kpi-value">${fmtINR(k.pending_net_rupees)}</div>
        <div class="kpi-sub">${k.open_withdrawals} open withdrawal requests</div>
      </div>
      <div class="kpi-card cyan">
        <div class="kpi-label">Creator Wallets Held</div>
        <div class="kpi-value">${fmtINR(k.wallet_liability_rupees)}</div>
        <div class="kpi-sub">${k.creators} creators • ${k.open_reports} open reports • ${k.open_tickets} tickets</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">14-Day Platform Razorpay Revenue</div></div>
      ${renderRevenueSvg(ov.trend, 'revenue_rupees', '#10b981')}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Recent Platform Payments</div></div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Time</th><th>Creator</th><th>Alias</th><th>Amount</th><th>Status</th><th>Razorpay Payment ID</th></tr></thead>
          <tbody>
            ${ov.recent_payments.map((p) => `
              <tr>
                <td>${fmtDate(p.paid_at)}</td>
                <td>@${esc(p.creator_username)}</td>
                <td>/${esc(p.alias)}</td>
                <td><strong>${fmtINR(p.amount_rupees)}</strong></td>
                <td><span class="badge ${p.status === 'paid' ? 'badge-success' : 'badge-danger'}">${esc(p.status)}</span></td>
                <td><code>${esc(p.rzp_payment_id)}</code></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminWithdrawals() {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Creator Withdrawals</div>
        <select class="form-control filter-select" onchange="state.adminWithdrawalFilter=this.value; switchAdminTab('withdrawals');">
          <option value="" ${state.adminWithdrawalFilter === '' ? 'selected' : ''}>All Requests</option>
          <option value="pending" ${state.adminWithdrawalFilter === 'pending' ? 'selected' : ''}>Pending</option>
          <option value="approved" ${state.adminWithdrawalFilter === 'approved' ? 'selected' : ''}>Approved</option>
          <option value="paid" ${state.adminWithdrawalFilter === 'paid' ? 'selected' : ''}>Paid</option>
          <option value="rejected" ${state.adminWithdrawalFilter === 'rejected' ? 'selected' : ''}>Rejected</option>
        </select>
      </div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>ID</th><th>Creator</th><th>Gross</th><th>Fee</th><th>Net Payable</th><th>Payout Details</th><th>Status / UTR</th><th>Actions</th></tr></thead>
          <tbody>
            ${state.adminWithdrawals.map((w) => {
              const pd = w.payout_details || {};
              const detailStr = w.method === 'upi' ? `UPI: ${pd.upi_id}` : `${pd.account_name} / ${pd.account_number} (${pd.ifsc})`;
              return `
                <tr>
                  <td>#${w.id}</td>
                  <td><strong>@${esc(w.username)}</strong><div style="font-size:0.76rem;color:var(--text-muted);">${esc(w.email)}</div></td>
                  <td>${fmtINR(w.gross_rupees)}</td>
                  <td>${w.commission_percent}% (${fmtINR(w.commission_rupees)})</td>
                  <td><strong style="color:var(--emerald-dark);">${fmtINR(w.net_rupees)}</strong></td>
                  <td><code class="break-all">${esc(detailStr)}</code></td>
                  <td>
                    <span class="badge ${w.status === 'paid' ? 'badge-success' : w.status === 'rejected' ? 'badge-danger' : 'badge-warning'}">${esc(w.status)}</span>
                    ${w.utr ? `<div style="font-size:0.76rem; margin-top:0.2rem;"><code>${esc(w.utr)}</code></div>` : ''}
                  </td>
                  <td>
                    ${['pending', 'approved'].includes(w.status) ? `
                      <div style="display:flex; gap:0.35rem; flex-wrap:wrap;">
                        ${w.status === 'pending' ? `<button class="btn btn-sm btn-outline" onclick="adminApproveWd(${w.id})">Approve</button>` : ''}
                        <button class="btn btn-sm btn-emerald" onclick="openPayWdModal(${w.id}, '${esc(w.username)}', ${w.net_rupees})">Mark Paid</button>
                        <button class="btn btn-sm btn-danger" onclick="adminRejectWd(${w.id})">Reject</button>
                      </div>
                    ` : '<span style="font-size:0.8rem;color:var(--text-muted);">Settled</span>'}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminPayments() {
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Razorpay Payments &amp; Refunds</div></div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>ID</th><th>Alias</th><th>Creator</th><th>Amount</th><th>Status</th><th>Razorpay IDs</th><th>Paid At</th><th>Action</th></tr></thead>
          <tbody>
            ${state.adminPayments.map((p) => `
              <tr>
                <td>#${p.id}</td>
                <td>/${esc(p.alias)}</td>
                <td>@${esc(p.creator_username)}</td>
                <td><strong>${fmtINR(p.amount_rupees)}</strong>${p.refunded_rupees > 0 ? `<div style="font-size:0.76rem;color:var(--rose);">Refunded: ${fmtINR(p.refunded_rupees)}</div>` : ''}</td>
                <td><span class="badge ${p.status === 'paid' ? 'badge-success' : p.status === 'refunded' ? 'badge-danger' : 'badge-neutral'}">${esc(p.status)}</span></td>
                <td><code style="font-size:0.75rem;">${esc(p.rzp_order_id)}</code>${p.rzp_payment_id ? `<br/><code style="font-size:0.75rem;">${esc(p.rzp_payment_id)}</code>` : ''}</td>
                <td>${fmtDate(p.paid_at || p.created_at)}</td>
                <td>${p.status === 'paid' && p.rzp_payment_id ? `<button class="btn btn-sm btn-danger" onclick="adminRefundPayment(${p.id})">Refund</button>` : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminUsers() {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Creators &amp; Users</div>
        <input type="text" class="form-control filter-input" value="${esc(state.adminUsersSearch)}" placeholder="Search username/email..." oninput="state.adminUsersSearch=this.value; loadAdminTab('users').then(render);" />
      </div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Default Price</th><th>Links / Unlocks</th><th>Wallet</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${state.adminUsers.map((u) => `
              <tr>
                <td><strong>@${esc(u.username)}</strong><div style="font-size:0.78rem;color:var(--text-muted);">${esc(u.email)}</div></td>
                <td><span class="badge ${u.role === 'admin' ? 'badge-warning' : 'badge-indigo'}">${esc(u.role)}</span></td>
                <td>₹${u.default_price_rupees}</td>
                <td>${u.links_count} / ${u.total_unlocks}</td>
                <td><strong>${fmtINR(u.balance_rupees)}</strong></td>
                <td><span class="badge ${u.status === 'active' ? 'badge-success' : 'badge-danger'}">${esc(u.status)}</span></td>
                <td><button class="btn btn-sm btn-primary" onclick="openAdminUserModal(${u.id})">Manage</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminLinks() {
  return `
    <div class="card">
      <div class="card-header">
        <div class="card-title">All Shortened Links</div>
        <input type="text" class="form-control filter-input" value="${esc(state.adminLinksSearch)}" placeholder="Search alias/creator..." oninput="state.adminLinksSearch=this.value; loadAdminTab('links').then(render);" />
      </div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Creator</th><th>Link &amp; Destination</th><th>Price</th><th>Unlocks / Clicks</th><th>Earned</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            ${state.adminLinks.map((l) => `
              <tr>
                <td>@${esc(l.creator_username)}</td>
                <td>
                  <strong>${esc(l.title || l.alias)}</strong> — <a href="/${esc(l.alias)}" target="_blank">/${esc(l.alias)}</a>
                  <div style="font-size:0.75rem;color:var(--text-muted);max-width:min(260px, 55vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(l.destination_url)}</div>
                </td>
                <td>₹${l.price_rupees}</td>
                <td>${l.unlocks} / ${l.clicks}</td>
                <td>${fmtINR(l.earned_rupees)}</td>
                <td><span class="badge ${l.status === 'active' ? 'badge-success' : l.status === 'blocked' ? 'badge-danger' : 'badge-warning'}">${esc(l.status)}</span></td>
                <td>
                  <div style="display:flex; gap:0.35rem;">
                    ${l.status !== 'blocked' ? `<button class="btn btn-sm btn-danger" onclick="adminModerateLink(${l.id}, 'blocked')">Block</button>` : `<button class="btn btn-sm btn-emerald" onclick="adminModerateLink(${l.id}, 'active')">Unblock</button>`}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderAdminReports() {
  const { reports, contacts } = state.adminReports;
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Abuse &amp; Broken Link Reports</div></div>
      ${reports.length === 0 ? '<p style="color:var(--text-muted);">No abuse reports.</p>' : reports.map((r) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:1rem; margin-bottom:0.85rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.35rem; flex-wrap:wrap; gap:0.5rem;">
            <strong>/${esc(r.alias)} — ${esc(r.reason)}</strong>
            <span class="badge ${r.status === 'open' ? 'badge-warning' : 'badge-neutral'}">${esc(r.status)}</span>
          </div>
          <p style="font-size:0.9rem; color:var(--text-muted);">${esc(r.details || 'No details')} ${r.reporter_email ? `(${esc(r.reporter_email)})` : ''}</p>
          ${r.status === 'open' ? `
            <div style="display:flex; gap:0.5rem; margin-top:0.6rem;">
              ${r.link_id ? `<button class="btn btn-sm btn-danger" onclick="adminResolveReport(${r.id}, 'resolved', true)">Block Link &amp; Resolve</button>` : ''}
              <button class="btn btn-sm btn-outline" onclick="adminResolveReport(${r.id}, 'dismissed', false)">Dismiss</button>
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Contact Form Inbox</div></div>
      ${contacts.length === 0 ? '<p style="color:var(--text-muted);">No contact messages yet.</p>' : contacts.map((c) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:1rem; margin-bottom:0.75rem;">
          <strong>${esc(c.subject)}</strong> <span style="font-size:0.84rem; color:var(--text-muted);">— ${esc(c.name)} (${esc(c.email)}) • ${fmtDate(c.created_at)}</span>
          <p style="font-size:0.9rem; margin-top:0.35rem;">${esc(c.message)}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAdminTickets() {
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Creator Support Tickets</div></div>
      ${state.adminTickets.length === 0 ? '<p style="color:var(--text-muted);">No tickets yet.</p>' : state.adminTickets.map((t) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:1rem; margin-bottom:0.85rem;">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.35rem; flex-wrap:wrap; gap:0.5rem;">
            <strong>#${t.id} — ${esc(t.subject)} (by @${esc(t.username)})</strong>
            <span class="badge ${t.status === 'open' ? 'badge-warning' : 'badge-success'}">${esc(t.status)}</span>
          </div>
          <p style="font-size:0.9rem; color:var(--text-muted); margin-bottom:0.65rem;">${esc(t.message)}</p>
          <div class="ticket-reply-row">
            <input type="text" id="tReply_${t.id}" class="form-control" value="${esc(t.admin_reply)}" placeholder="Type admin reply..." />
            <button class="btn btn-sm btn-primary" onclick="adminReplyTicket(${t.id})">Reply</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderAdminSettings() {
  const s = state.adminSettings || state.settings;
  return `
    <div class="card" style="max-width:860px;">
      <div class="card-header"><div class="card-title">Platform Pricing, Commission &amp; KYC Settings</div></div>
      <form onsubmit="saveAdminSettings(event)">
        <div class="grid-3" style="gap:0.9rem;">
          <div class="form-group">
            <label class="form-label">Withdrawal Commission (%)</label>
            <input type="number" id="asComm" class="form-control" min="0" max="50" step="0.01" value="${s.withdrawal_commission_percent}" required />
            <div class="form-hint">Set 0% while scaling, or 5% / 10% anytime.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Default Price / Link (Whole ₹)</label>
            <input type="number" id="asDefPrice" class="form-control" min="1" step="1" value="${s.default_price_rupees}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Minimum Price / Link (Whole ₹)</label>
            <input type="number" id="asMinPrice" class="form-control" min="1" step="1" value="${s.min_price_rupees}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Maximum Price / Link (Whole ₹)</label>
            <input type="number" id="asMaxPrice" class="form-control" min="1" step="1" value="${s.max_price_rupees}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Minimum Withdrawal (₹)</label>
            <input type="number" id="asMinWd" class="form-control" min="1" step="1" value="${s.min_withdrawal_rupees}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Referral Bonus (%)</label>
            <input type="number" id="asRefPct" class="form-control" min="0" max="50" step="0.5" value="${s.referral_percent}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Unlock Validity (Hours)</label>
            <input type="number" id="asValidHrs" class="form-control" min="1" max="8760" step="1" value="${s.unlock_validity_hours}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Max Opens Per Payment</label>
            <input type="number" id="asMaxOpens" class="form-control" min="1" max="1000" step="1" value="${s.max_opens_per_payment}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Registrations Open</label>
            <select id="asRegOpen" class="form-control">
              <option value="true" ${s.registrations_open ? 'selected' : ''}>Yes</option>
              <option value="false" ${!s.registrations_open ? 'selected' : ''}>Closed</option>
            </select>
          </div>
        </div>

        <hr style="margin:1.2rem 0; border:none; border-top:1px solid var(--border);" />
        <h3 style="font-size:1.02rem; font-weight:700; margin-bottom:0.8rem;">Business &amp; Razorpay KYC Compliance Details</h3>
        <div class="grid-2" style="gap:0.9rem;">
          <div class="form-group">
            <label class="form-label">Site Brand Name</label>
            <input type="text" id="asSiteName" class="form-control" value="${esc(s.site_name)}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Legal / Company Name</label>
            <input type="text" id="asCompName" class="form-control" value="${esc(s.company_name)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Support Email</label>
            <input type="email" id="asEmail" class="form-control" value="${esc(s.support_email)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Support Phone</label>
            <input type="text" id="asPhone" class="form-control" value="${esc(s.support_phone)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Grievance Officer</label>
            <input type="text" id="asGriev" class="form-control" value="${esc(s.grievance_officer)}" />
          </div>
          <div class="form-group">
            <label class="form-label">Show Public Counters on Home</label>
            <select id="asShowStats" class="form-control">
              <option value="true" ${s.show_public_stats ? 'selected' : ''}>Yes</option>
              <option value="false" ${!s.show_public_stats ? 'selected' : ''}>No</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Registered Business Address</label>
          <input type="text" id="asAddr" class="form-control" value="${esc(s.business_address)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Creator Dashboard Announcement (Optional)</label>
          <input type="text" id="asAnn" class="form-control" value="${esc(s.announcement)}" />
        </div>
        <button type="submit" class="btn btn-primary btn-lg">Save Settings</button>
      </form>
    </div>
  `;
}

function renderAdminLogs() {
  return `
    <div class="card">
      <div class="card-header"><div class="card-title">Admin Audit Log</div></div>
      <div class="table-responsive">
        <table>
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>
            ${state.adminLogs.map((l) => `
              <tr>
                <td>${fmtDate(l.created_at)}</td>
                <td>@${esc(l.actor_username || 'system')}</td>
                <td><code>${esc(l.action)}</code></td>
                <td>${esc(l.target_type)} #${esc(l.target_id)}</td>
                <td><code class="break-all" style="font-size:0.76rem;">${esc(JSON.stringify(l.details))}</code></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ============================================================================
// HANDLERS
// ============================================================================

async function handleLogin(e) {
  e.preventDefault();
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: document.getElementById('loginId').value,
        password: document.getElementById('loginPass').value
      })
    });
    state.user = res.user;
    toast(`Welcome back, @${res.user.username}!`);
    await navigate(res.user.role === 'admin' ? 'admin' : 'member', res.user.role === 'admin' ? 'overview' : 'stats');
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  try {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        full_name: document.getElementById('regName').value,
        username: document.getElementById('regUser').value,
        email: document.getElementById('regEmail').value,
        password: document.getElementById('regPass').value,
        ref: document.getElementById('regRef').value,
        accept_terms: document.getElementById('regTerms').checked
      })
    });
    state.user = res.user;
    toast('Creator account created!');
    await navigate('member', 'stats');
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleForgot(e) {
  e.preventDefault();
  try {
    const res = await api('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('forgotEmail').value })
    });
    toast(res.message);
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleResetPassword(e, token) {
  e.preventDefault();
  try {
    const res = await api('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: document.getElementById('resetPass').value })
    });
    state.user = res.user;
    toast('Password updated!');
    await navigate('member', 'stats');
  } catch (err) {
    toast(err.message, true);
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  state.lastCreatedLink = null;
  state.revealedApiKey = null;
  state.revealedWebhookSecret = null;
  toast('Signed out.');
  await navigate('home');
}

async function handleQuickShorten(e) {
  e.preventDefault();
  const check = validateWholeRupeesClient(document.getElementById('quickPrice').value);
  if (!check.valid) return toast(check.error, true);
  try {
    const res = await api('/api/member/links', {
      method: 'POST',
      body: JSON.stringify({
        url: document.getElementById('quickUrl').value,
        alias: document.getElementById('quickAlias').value || undefined,
        price: check.price
      })
    });
    state.lastCreatedLink = res.link;
    toast(`Created /${res.link.alias} at ₹${res.link.price_rupees}/unlock!`);
    await loadMemberTab(state.memberTab);
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function searchMemberLinks(val) {
  state.linksSearch = val;
  loadMemberTab('links').then(() => {
    render();
    const el = document.getElementById('linksSearchInput');
    if (el) {
      el.focus();
      el.setSelectionRange(val.length, val.length);
    }
  });
}

function openEditLinkModal(alias) {
  const link = state.links.find((x) => x.alias === alias);
  if (!link) return;
  showModal(`
    <div class="modal-card">
      <h3 style="font-size:1.2rem; font-weight:800; margin-bottom:1rem;">Edit /${esc(link.alias)}</h3>
      <form onsubmit="saveLinkEdit(event, '${esc(link.alias)}')">
        <div class="form-group">
          <label class="form-label">Title</label>
          <input type="text" id="elTitle" class="form-control" value="${esc(link.title)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Destination URL</label>
          <input type="url" id="elUrl" class="form-control" value="${esc(link.destination_url)}" required />
        </div>
        <div class="grid-2" style="gap:0.85rem;">
          <div class="form-group">
            <label class="form-label">Price Per Click (Whole ₹ ≥ ${state.settings.min_price_rupees})</label>
            <input type="number" id="elPrice" class="form-control" min="${state.settings.min_price_rupees}" step="1" value="${link.price_rupees}" required />
          </div>
          <div class="form-group">
            <label class="form-label">Status</label>
            <select id="elStatus" class="form-control">
              <option value="active" ${link.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="paused" ${link.status === 'paused' ? 'selected' : ''}>Paused</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">External Reference Tag (Optional)</label>
          <input type="text" id="elRef" class="form-control" value="${esc(link.external_ref || '')}" />
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.6rem; margin-top:1rem;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Changes</button>
        </div>
      </form>
    </div>
  `);
}

async function saveLinkEdit(e, alias) {
  e.preventDefault();
  const check = validateWholeRupeesClient(document.getElementById('elPrice').value);
  if (!check.valid) return toast(check.error, true);
  try {
    await api(`/api/member/links/${encodeURIComponent(alias)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: document.getElementById('elTitle').value,
        url: document.getElementById('elUrl').value,
        price: check.price,
        status: document.getElementById('elStatus').value,
        ref: document.getElementById('elRef').value
      })
    });
    closeModal();
    toast('Link updated!');
    await loadMemberTab('links');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteLink(alias) {
  if (!confirm(`Delete link /${alias}?`)) return;
  try {
    await api(`/api/member/links/${encodeURIComponent(alias)}`, { method: 'DELETE' });
    toast('Link deleted.');
    await loadMemberTab('links');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleMassShrink(e) {
  e.preventDefault();
  const check = validateWholeRupeesClient(document.getElementById('massPrice').value);
  if (!check.valid) return toast(check.error, true);
  const urls = document.getElementById('massUrls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  try {
    const res = await api('/api/member/links/mass', {
      method: 'POST',
      body: JSON.stringify({ urls, price: check.price })
    });
    state.massResults = res;
    toast(`Created ${res.created.length} links!`);
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleWithdrawSubmit(e) {
  e.preventDefault();
  const method = document.getElementById('wdMethod').value;
  const payload = {
    amount_rupees: document.getElementById('wdAmount').value,
    method
  };
  if (method === 'upi') {
    payload.upi_id = document.getElementById('wdUpi').value;
  } else {
    payload.bank_account_name = document.getElementById('wdBankName').value;
    const acc = document.getElementById('wdBankAcc').value.trim();
    if (acc) payload.bank_account_number = acc;
    payload.bank_ifsc = document.getElementById('wdBankIfsc').value;
  }
  try {
    await api('/api/member/withdrawals', { method: 'POST', body: JSON.stringify(payload) });
    toast('Withdrawal request submitted!');
    await loadMemberTab('withdraw');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function regenApiKey() {
  if (state.user.has_api_key && !confirm('Regenerate API key? Your existing key will stop working immediately.')) return;
  try {
    const res = await api('/api/member/api-key/regenerate', { method: 'POST' });
    state.user = res.user;
    state.revealedApiKey = res.api_key;
    toast('New secret API key generated!');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveCreatorWebhook(e) {
  e.preventDefault();
  try {
    const res = await api('/api/member/webhook', {
      method: 'PATCH',
      body: JSON.stringify({ webhook_url: document.getElementById('whUrlInput').value })
    });
    state.user = res.user;
    if (res.webhook_secret) state.revealedWebhookSecret = res.webhook_secret;
    toast('Webhook configuration saved!');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function revealWebhookSecret() {
  try {
    const res = await api('/api/member/webhook/reveal-secret', { method: 'POST' });
    state.revealedWebhookSecret = res.webhook_secret;
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function testCreatorWebhook() {
  try {
    const res = await api('/api/member/webhook/test', { method: 'POST' });
    toast(res.ok ? `Webhook responded HTTP ${res.status}!` : `Webhook returned HTTP ${res.status}`, !res.ok);
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveMemberSettings(e) {
  e.preventDefault();
  const check = validateWholeRupeesClient(document.getElementById('setDefPrice').value);
  if (!check.valid) return toast(check.error, true);
  const payload = {
    default_price_rupees: check.price,
    full_name: document.getElementById('setFullName').value,
    phone: document.getElementById('setPhone').value,
    payout_method: document.getElementById('setPayMethod').value,
    upi_id: document.getElementById('setUpi').value,
    bank_account_name: document.getElementById('setBankName').value,
    bank_ifsc: document.getElementById('setIfsc').value
  };
  const bankAcc = document.getElementById('setBankAcc').value.trim();
  if (bankAcc) payload.bank_account_number = bankAcc;
  const newPass = document.getElementById('setNewPass').value;
  if (newPass) {
    payload.current_password = document.getElementById('setCurrPass').value;
    payload.new_password = newPass;
  }
  try {
    const res = await api('/api/member/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    state.user = res.user;
    toast('Settings saved!');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function createTicket(e) {
  e.preventDefault();
  try {
    await api('/api/member/tickets', {
      method: 'POST',
      body: JSON.stringify({
        subject: document.getElementById('tSubject').value,
        category: document.getElementById('tCat').value,
        message: document.getElementById('tMsg').value
      })
    });
    toast('Support ticket submitted!');
    await loadMemberTab('support');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleContactSubmit(e) {
  e.preventDefault();
  try {
    const res = await api('/api/public/contact', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('contactName').value,
        email: document.getElementById('contactEmail').value,
        subject: document.getElementById('contactSubject').value,
        message: document.getElementById('contactMsg').value
      })
    });
    toast(res.message);
    e.target.reset();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handleAbuseReport(e) {
  e.preventDefault();
  try {
    const res = await api('/api/public/report', {
      method: 'POST',
      body: JSON.stringify({
        alias: document.getElementById('repAlias').value,
        reason: document.getElementById('repReason').value,
        details: document.getElementById('repDetails').value,
        email: document.getElementById('repEmail').value || undefined
      })
    });
    toast(res.message);
    e.target.reset();
  } catch (err) {
    toast(err.message, true);
  }
}

// ============================================================================
// ADMIN HANDLERS
// ============================================================================

async function adminApproveWd(id) {
  try {
    await api(`/api/admin/withdrawals/${id}/approve`, { method: 'POST' });
    toast(`Withdrawal #${id} approved.`);
    await loadAdminTab('withdrawals');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function openPayWdModal(id, username, net) {
  showModal(`
    <div class="modal-card">
      <h3 style="font-size:1.2rem; font-weight:800; margin-bottom:0.5rem;">Mark Withdrawal #${id} Paid</h3>
      <p style="color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;">Enter the UTR / Bank Transaction Reference for <strong>${fmtINR(net)}</strong> sent to <strong>@${esc(username)}</strong>.</p>
      <form onsubmit="submitPayWd(event, ${id})">
        <div class="form-group">
          <label class="form-label">UTR / Transaction Reference</label>
          <input type="text" id="payUtrInput" class="form-control" required minlength="4" placeholder="e.g. 432198765432" />
        </div>
        <div class="form-group">
          <label class="form-label">Note (Optional)</label>
          <input type="text" id="payNoteInput" class="form-control" />
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.6rem; margin-top:1rem;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-emerald">Confirm Paid</button>
        </div>
      </form>
    </div>
  `);
}

async function submitPayWd(e, id) {
  e.preventDefault();
  try {
    await api(`/api/admin/withdrawals/${id}/pay`, {
      method: 'POST',
      body: JSON.stringify({
        utr: document.getElementById('payUtrInput').value,
        admin_note: document.getElementById('payNoteInput').value
      })
    });
    closeModal();
    toast(`Withdrawal #${id} settled!`);
    await loadAdminTab('withdrawals');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function adminRejectWd(id) {
  const reason = prompt('Reason for rejecting withdrawal (refunded to creator wallet):', 'Invalid payout account');
  if (reason === null) return;
  try {
    await api(`/api/admin/withdrawals/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ admin_note: reason })
    });
    toast(`Withdrawal #${id} rejected & refunded to creator.`);
    await loadAdminTab('withdrawals');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function adminRefundPayment(id) {
  if (!confirm('Issue a full Razorpay refund for this payment and debit the creator balance?')) return;
  try {
    const res = await api(`/api/admin/payments/${id}/refund`, { method: 'POST' });
    toast(`Refund processed (${res.refund_id})!`);
    await loadAdminTab('payments');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function openAdminUserModal(id) {
  const u = state.adminUsers.find((x) => x.id === id);
  if (!u) return;
  showModal(`
    <div class="modal-card">
      <h3 style="font-size:1.2rem; font-weight:800; margin-bottom:1rem;">Manage @${esc(u.username)}</h3>
      <form onsubmit="saveAdminUser(event, ${u.id})">
        <div class="grid-2" style="gap:0.85rem;">
          <div class="form-group">
            <label class="form-label">Status</label>
            <select id="auStatus" class="form-control">
              <option value="active" ${u.status === 'active' ? 'selected' : ''}>Active</option>
              <option value="suspended" ${u.status === 'suspended' ? 'selected' : ''}>Suspended</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Role</label>
            <select id="auRole" class="form-control">
              <option value="creator" ${u.role === 'creator' ? 'selected' : ''}>Creator</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Default Price Per Link (Whole ₹)</label>
          <input type="number" id="auPrice" class="form-control" min="1" step="1" value="${u.default_price_rupees}" required />
        </div>
        <div class="grid-2" style="gap:0.85rem;">
          <div class="form-group">
            <label class="form-label">Balance Adjustment (± ₹, optional)</label>
            <input type="text" id="auAdj" class="form-control" placeholder="e.g. 50 or -25" />
          </div>
          <div class="form-group">
            <label class="form-label">Adjustment Reason</label>
            <input type="text" id="auAdjNote" class="form-control" placeholder="Bonus / Correction" />
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:0.6rem; margin-top:1rem;">
          <button type="button" class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button type="submit" class="btn btn-primary">Update User</button>
        </div>
      </form>
    </div>
  `);
}

async function saveAdminUser(e, id) {
  e.preventDefault();
  try {
    await api(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: document.getElementById('auStatus').value,
        role: document.getElementById('auRole').value,
        default_price_rupees: document.getElementById('auPrice').value,
        adjust_rupees: document.getElementById('auAdj').value || undefined,
        adjust_note: document.getElementById('auAdjNote').value || undefined
      })
    });
    closeModal();
    toast('User updated.');
    await loadAdminTab('users');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function adminModerateLink(id, status) {
  try {
    await api(`/api/admin/links/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    toast(`Link updated to ${status}.`);
    await loadAdminTab('links');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function adminResolveReport(id, status, block_link) {
  try {
    await api(`/api/admin/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ status, block_link }) });
    toast('Report updated.');
    await loadAdminTab('reports');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function adminReplyTicket(id) {
  const admin_reply = document.getElementById(`tReply_${id}`).value;
  try {
    await api(`/api/admin/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify({ admin_reply, status: 'answered' }) });
    toast('Ticket replied!');
    await loadAdminTab('tickets');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAdminSettings(e) {
  e.preventDefault();
  try {
    const res = await api('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        withdrawal_commission_percent: document.getElementById('asComm').value,
        default_price_rupees: document.getElementById('asDefPrice').value,
        min_price_rupees: document.getElementById('asMinPrice').value,
        max_price_rupees: document.getElementById('asMaxPrice').value,
        min_withdrawal_rupees: document.getElementById('asMinWd').value,
        referral_percent: document.getElementById('asRefPct').value,
        unlock_validity_hours: document.getElementById('asValidHrs').value,
        max_opens_per_payment: document.getElementById('asMaxOpens').value,
        registrations_open: document.getElementById('asRegOpen').value,
        site_name: document.getElementById('asSiteName').value,
        company_name: document.getElementById('asCompName').value,
        support_email: document.getElementById('asEmail').value,
        support_phone: document.getElementById('asPhone').value,
        grievance_officer: document.getElementById('asGriev').value,
        show_public_stats: document.getElementById('asShowStats').value,
        business_address: document.getElementById('asAddr').value,
        announcement: document.getElementById('asAnn').value
      })
    });
    state.adminSettings = res.settings;
    state.settings = res.settings;
    toast('Platform & KYC settings saved!');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

bootstrap();

