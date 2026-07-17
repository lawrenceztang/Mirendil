CREATE TABLE connections (
  name TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
