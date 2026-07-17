CREATE TYPE session_status AS ENUM ('idle', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted');

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  repo_url TEXT,
  branch TEXT,
  agent_count SMALLINT NOT NULL DEFAULT 1 CHECK (agent_count BETWEEN 1 AND 4),
  status session_status NOT NULL DEFAULT 'idle',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status run_status NOT NULL DEFAULT 'queued',
  summary TEXT,
  error TEXT,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX runs_queue_idx ON runs(status, created_at);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE secrets (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, name)
);
