-- HOA site schema (PostgreSQL 14+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS announcements (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        TEXT NOT NULL,
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  author      TEXT,
  emailed_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_order ON announcements (pinned DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'General',   -- Bylaws, Minutes, Financials, Forms...
  description  TEXT,
  s3_key       TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes   BIGINT,
  uploaded     BOOLEAN NOT NULL DEFAULT FALSE,     -- true once the browser finishes the S3 upload
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents (category, created_at DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  id                SERIAL PRIMARY KEY,
  email             CITEXT NOT NULL UNIQUE,
  name              TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'active', 'unsubscribed')),
  confirm_token     UUID NOT NULL DEFAULT gen_random_uuid(),
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at      TIMESTAMPTZ,
  unsubscribed_at   TIMESTAMPTZ
);

-- ---------- Board-only meeting minutes ----------
-- Files live in the documents bucket under board/minutes/. No public route reads these tables.
CREATE TABLE IF NOT EXISTS minutes (
  id              SERIAL PRIMARY KEY,
  meeting_date    DATE NOT NULL,
  title           TEXT NOT NULL,
  s3_key          TEXT,                    -- current file (null until the first upload finishes)
  pending_s3_key  TEXT,                    -- upload in progress (first version or a revision)
  filename        TEXT,
  content_type    TEXT,
  size_bytes      BIGINT,
  pending_filename     TEXT,
  pending_content_type TEXT,
  version         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  uploaded_by     TEXT NOT NULL,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_minutes_date ON minutes (meeting_date DESC);

CREATE TABLE IF NOT EXISTS minutes_comments (
  id          SERIAL PRIMARY KEY,
  minutes_id  INTEGER NOT NULL REFERENCES minutes(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  version     INTEGER NOT NULL,            -- which version of the file the comment was about
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_minutes_comments ON minutes_comments (minutes_id, created_at);

-- "I've reviewed this version." Cleared whenever a revised file is uploaded.
CREATE TABLE IF NOT EXISTS minutes_signoffs (
  minutes_id  INTEGER NOT NULL REFERENCES minutes(id) ON DELETE CASCADE,
  reviewer    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (minutes_id, reviewer)
);

-- ---------- Board logins managed on the website ----------
-- Logins in the Lambda's ADMIN_USERS setting still work and can't be removed from the site;
-- they're the recovery logins. Everything below is managed from the Board members tab.
CREATE TABLE IF NOT EXISTS board_users (
  username             TEXT PRIMARY KEY CHECK (username ~ '^[a-z0-9._-]{2,40}$'),
  iterations           INTEGER NOT NULL,
  salt                 TEXT NOT NULL,
  hash                 TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,   -- true after an add or a reset
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at  TIMESTAMPTZ,
  last_sign_in_at      TIMESTAMPTZ
);

-- Who added, removed, or reset which login, and when.
CREATE TABLE IF NOT EXISTS board_audit (
  id          SERIAL PRIMARY KEY,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_board_audit_created ON board_audit (created_at DESC);

-- ---------- Self-service password reset ----------
-- Email address used for "Forgot your password?" links. Added separately so existing installs upgrade.
ALTER TABLE board_users ADD COLUMN IF NOT EXISTS email CITEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_users_email ON board_users (email) WHERE email IS NOT NULL;

-- One-time reset links. Only a SHA-256 hash of the token is stored; the link expires after an hour.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash  TEXT PRIMARY KEY,
  username    TEXT NOT NULL REFERENCES board_users(username) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (username, created_at DESC);
