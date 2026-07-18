ALTER TABLE runs ADD COLUMN thinking_level TEXT CHECK (thinking_level IN ('low','medium','high','xhigh'));
