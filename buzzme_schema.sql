-- BuzzMe schema, first version (spec section 9), PostgreSQL.
-- Safe to run repeatedly. All timestamps are timestamptz (stored as UTC).

CREATE TABLE IF NOT EXISTS bans (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash       TEXT        NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),  -- HMAC-SHA256 hex, never a raw IP
  device_token  VARCHAR(64),                                              -- hash of the client's device token, if sent
  reason        VARCHAR(255) NOT NULL,
  expires_at    TIMESTAMPTZ,                                              -- NULL = permanent ban
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bans_ip_hash ON bans (ip_hash);
CREATE INDEX IF NOT EXISTS idx_bans_device_token ON bans (device_token);

CREATE TABLE IF NOT EXISTS reports (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_ip_hash  TEXT        NOT NULL CHECK (reporter_ip_hash ~ '^[0-9a-f]{64}$'),
  reported_ip_hash  TEXT        NOT NULL CHECK (reported_ip_hash ~ '^[0-9a-f]{64}$'),
  mode              TEXT        NOT NULL CHECK (mode IN ('video','voice','text')),
  reason            VARCHAR(500) NOT NULL,
  message_snapshot  JSONB,                                                -- short snapshot, text mode only (spec section 7)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_reports_snapshot_text_only
    CHECK (message_snapshot IS NULL OR mode = 'text')
);
