WITH duplicate_running AS (
  SELECT id,row_number() OVER (PARTITION BY session_id ORDER BY started_at NULLS LAST,created_at,id) AS position
  FROM runs
  WHERE status='running'
)
UPDATE runs
SET status='interrupted',finished_at=now(),lease_expires_at=null,error=COALESCE(error,'Interrupted while enforcing per-session run serialization')
WHERE id IN (SELECT id FROM duplicate_running WHERE position>1);

CREATE UNIQUE INDEX one_running_run_per_session
ON runs(session_id)
WHERE status='running';
