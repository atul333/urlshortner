'use strict';

// Ordered, append-only list of migrations. Never edit an applied migration;
// add a new entry instead.
module.exports = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE IF NOT EXISTS settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                        BIGSERIAL PRIMARY KEY,
  username                  VARCHAR(32)  NOT NULL,
  email                     VARCHAR(255) NOT NULL,
  password_hash             TEXT         NOT NULL,
  full_name                 VARCHAR(120) NOT NULL DEFAULT '',
  phone                     VARCHAR(20)  NOT NULL DEFAULT '',
  role                      VARCHAR(16)  NOT NULL DEFAULT 'creator' CHECK (role IN ('creator','admin')),
  status                    VARCHAR(16)  NOT NULL DEFAULT 'active'  CHECK (status IN ('active','suspended')),
  token_version             INTEGER      NOT NULL DEFAULT 0,
  default_price_rupees      INTEGER      NOT NULL DEFAULT 1 CHECK (default_price_rupees >= 1),
  balance_paise             BIGINT       NOT NULL DEFAULT 0,
  pending_withdrawal_paise  BIGINT       NOT NULL DEFAULT 0 CHECK (pending_withdrawal_paise >= 0),
  total_withdrawn_paise     BIGINT       NOT NULL DEFAULT 0,
  lifetime_earned_paise     BIGINT       NOT NULL DEFAULT 0,
  referral_earned_paise     BIGINT       NOT NULL DEFAULT 0,
  referred_by               BIGINT       REFERENCES users(id) ON DELETE SET NULL,
  api_key_hash              CHAR(64)     UNIQUE,
  api_key_prefix            VARCHAR(20),
  public_key                VARCHAR(40)  NOT NULL UNIQUE,
  payout_method             VARCHAR(16)  NOT NULL DEFAULT 'upi' CHECK (payout_method IN ('upi','bank')),
  upi_id                    VARCHAR(100) NOT NULL DEFAULT '',
  bank_account_name         VARCHAR(120) NOT NULL DEFAULT '',
  bank_account_number       VARCHAR(34)  NOT NULL DEFAULT '',
  bank_ifsc                 VARCHAR(11)  NOT NULL DEFAULT '',
  webhook_url               TEXT         NOT NULL DEFAULT '',
  webhook_secret            VARCHAR(80)  NOT NULL DEFAULT '',
  last_login_at             TIMESTAMPTZ,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq    ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_referred_by_idx           ON users (referred_by);

CREATE TABLE IF NOT EXISTS links (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias             VARCHAR(40)  NOT NULL,
  title             VARCHAR(200) NOT NULL DEFAULT '',
  destination_url   TEXT         NOT NULL,
  destination_hash  CHAR(64)     NOT NULL,
  price_rupees      INTEGER      NOT NULL CHECK (price_rupees >= 1),
  status            VARCHAR(16)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','blocked')),
  external_ref      VARCHAR(120),
  source            VARCHAR(16)  NOT NULL DEFAULT 'dashboard',
  expires_at        TIMESTAMPTZ,
  clicks            BIGINT       NOT NULL DEFAULT 0,
  unlocks           BIGINT       NOT NULL DEFAULT 0,
  earned_paise      BIGINT       NOT NULL DEFAULT 0,
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS links_alias_lower_uq ON links (lower(alias));
CREATE INDEX IF NOT EXISTS links_user_created_idx ON links (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS links_user_dest_idx    ON links (user_id, destination_hash, price_rupees);
CREATE INDEX IF NOT EXISTS links_user_ref_idx     ON links (user_id, external_ref);

CREATE TABLE IF NOT EXISTS payments (
  id                       BIGSERIAL PRIMARY KEY,
  link_id                  BIGINT       NOT NULL REFERENCES links(id),
  creator_id               BIGINT       NOT NULL REFERENCES users(id),
  amount_paise             BIGINT       NOT NULL CHECK (amount_paise >= 100),
  currency                 CHAR(3)      NOT NULL DEFAULT 'INR',
  rzp_order_id             VARCHAR(64)  NOT NULL UNIQUE,
  rzp_payment_id           VARCHAR(64)  UNIQUE,
  status                   VARCHAR(16)  NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refunded')),
  paid_via                 VARCHAR(16),
  visitor_hash             CHAR(64)     NOT NULL,
  ip_hash                  CHAR(64)     NOT NULL,
  user_agent               VARCHAR(300) NOT NULL DEFAULT '',
  device                   VARCHAR(16)  NOT NULL DEFAULT 'desktop',
  referrer_host            VARCHAR(200) NOT NULL DEFAULT '',
  unlock_expires_at        TIMESTAMPTZ,
  unlock_opens             INTEGER      NOT NULL DEFAULT 0,
  access_token_hash        CHAR(64)     UNIQUE,
  access_token_expires_at  TIMESTAMPTZ,
  refunded_paise           BIGINT       NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  paid_at                  TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_creator_paid_idx  ON payments (creator_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS payments_link_visitor_idx  ON payments (link_id, visitor_hash, status);
CREATE INDEX IF NOT EXISTS payments_status_created_idx ON payments (status, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_refunds (
  id             BIGSERIAL PRIMARY KEY,
  payment_id     BIGINT      NOT NULL REFERENCES payments(id),
  rzp_refund_id  VARCHAR(64) NOT NULL UNIQUE,
  amount_paise   BIGINT      NOT NULL CHECK (amount_paise > 0),
  created_by     BIGINT      REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT      NOT NULL REFERENCES users(id),
  gross_paise       BIGINT      NOT NULL CHECK (gross_paise > 0),
  commission_bp     INTEGER     NOT NULL DEFAULT 0 CHECK (commission_bp >= 0 AND commission_bp <= 5000),
  commission_paise  BIGINT      NOT NULL DEFAULT 0,
  net_paise         BIGINT      NOT NULL CHECK (net_paise >= 0),
  method            VARCHAR(16) NOT NULL,
  payout_details    JSONB       NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
  utr               VARCHAR(64) NOT NULL DEFAULT '',
  admin_note        VARCHAR(255) NOT NULL DEFAULT '',
  processed_by      BIGINT      REFERENCES users(id),
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawals_user_idx   ON withdrawals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT       NOT NULL REFERENCES users(id),
  entry_type           VARCHAR(32)  NOT NULL,
  amount_paise         BIGINT       NOT NULL,
  balance_after_paise  BIGINT       NOT NULL,
  payment_id           BIGINT       REFERENCES payments(id),
  withdrawal_id        BIGINT       REFERENCES withdrawals(id),
  note                 VARCHAR(255) NOT NULL DEFAULT '',
  created_by           BIGINT       REFERENCES users(id),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx ON wallet_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS link_daily_stats (
  link_id       BIGINT  NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  user_id       BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day           DATE    NOT NULL,
  clicks        INTEGER NOT NULL DEFAULT 0,
  unlocks       INTEGER NOT NULL DEFAULT 0,
  earned_paise  BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day)
);
CREATE INDEX IF NOT EXISTS link_daily_stats_user_day_idx ON link_daily_stats (user_id, day);

CREATE TABLE IF NOT EXISTS razorpay_events (
  event_id     VARCHAR(80) PRIMARY KEY,
  event_type   VARCHAR(64) NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id     BIGINT      REFERENCES payments(id),
  event          VARCHAR(48) NOT NULL,
  url            TEXT        NOT NULL,
  payload        JSONB       NOT NULL,
  attempts       INTEGER     NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  last_status    INTEGER,
  last_error     VARCHAR(255) NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_user_idx ON webhook_deliveries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      VARCHAR(200) NOT NULL,
  category     VARCHAR(48)  NOT NULL DEFAULT 'general',
  message      TEXT         NOT NULL,
  admin_reply  TEXT         NOT NULL DEFAULT '',
  status       VARCHAR(16)  NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_user_idx   ON tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets (status, created_at DESC);

CREATE TABLE IF NOT EXISTS abuse_reports (
  id             BIGSERIAL PRIMARY KEY,
  link_id        BIGINT       REFERENCES links(id) ON DELETE SET NULL,
  alias          VARCHAR(40)  NOT NULL,
  reason         VARCHAR(48)  NOT NULL,
  details        TEXT         NOT NULL DEFAULT '',
  reporter_email VARCHAR(255) NOT NULL DEFAULT '',
  ip_hash        CHAR(64)     NOT NULL,
  status         VARCHAR(16)  NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_messages (
  id          BIGSERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  subject     VARCHAR(200) NOT NULL,
  message     TEXT         NOT NULL,
  ip_hash     CHAR(64)     NOT NULL,
  status      VARCHAR(16)  NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  CHAR(64)    NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(32) NOT NULL DEFAULT '',
  target_id   VARCHAR(64) NOT NULL DEFAULT '',
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
`
  }
];

