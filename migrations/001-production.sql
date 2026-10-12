BEGIN;
CREATE TABLE IF NOT EXISTS autopsy_schema (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS autopsy_limits (
  key text PRIMARY KEY,
  count bigint NOT NULL CHECK (count >= 0),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS autopsy_limits_expiry ON autopsy_limits(reset_at);
CREATE TABLE IF NOT EXISTS autopsy_snapshots (
  id char(64) PRIMARY KEY,
  repository text NOT NULL,
  analyzed_at timestamptz NOT NULL,
  content text NOT NULL CHECK (octet_length(content) <= 1000000),
  summary jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS autopsy_snapshots_history ON autopsy_snapshots(repository, analyzed_at DESC, id);
INSERT INTO autopsy_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
