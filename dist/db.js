import pg from 'pg';
import { config } from './config.js';
const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 15_000, ssl: config.isSupabase ? { rejectUnauthorized: false } : undefined });
const sessionColumns = `id, user_id AS "userId", title, repo_url AS "repoUrl", branch, agent_count AS "agentCount", status, pr_url AS "prUrl", pr_branch AS "prBranch", created_at AS "createdAt", updated_at AS "updatedAt"`;
const runColumns = `id, session_id AS "sessionId", prompt, status, summary, error, pr_url AS "prUrl", thinking_level AS "thinkingLevel", cancel_requested AS "cancelRequested", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;
const leasedRunColumns = `r.id, r.session_id AS "sessionId", r.prompt, r.status, r.summary, r.error, r.pr_url AS "prUrl", r.thinking_level AS "thinkingLevel", r.cancel_requested AS "cancelRequested", r.created_at AS "createdAt", r.started_at AS "startedAt", r.finished_at AS "finishedAt"`;
export const leaseRunSql = `WITH next AS (
  SELECT candidate.id FROM runs candidate
  JOIN sessions chat ON chat.id=candidate.session_id
  WHERE (candidate.status='queued' AND NOT EXISTS (
    SELECT 1 FROM runs earlier WHERE earlier.session_id=candidate.session_id AND (
      (earlier.status='queued' AND (earlier.created_at,earlier.id)<(candidate.created_at,candidate.id)) OR earlier.status='running'
    )
  )) OR (candidate.status='running' AND candidate.lease_expires_at<now())
  ORDER BY candidate.created_at,candidate.id
  FOR UPDATE OF candidate,chat SKIP LOCKED LIMIT 1
)
UPDATE runs r SET status='running',worker_id=$1,lease_expires_at=now()+interval '30 seconds',started_at=COALESCE(r.started_at,now())
FROM next WHERE r.id=next.id RETURNING ${leasedRunColumns}`;
export const db = {
    async sessions(userId) { return (await pool.query(`SELECT ${sessionColumns} FROM sessions WHERE user_id=$1 ORDER BY updated_at DESC`, [userId])).rows; },
    async session(id, userId) { return (await pool.query(`SELECT ${sessionColumns} FROM sessions WHERE id=$1${userId ? ' AND user_id=$2' : ''}`, userId ? [id, userId] : [id])).rows[0] || null; },
    async createSession(userId, input) {
        return (await pool.query(`INSERT INTO sessions(id,user_id,title,repo_url,branch,agent_count) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING ${sessionColumns}`, [userId, input.title, input.repoUrl || null, input.branch || null, input.agentCount])).rows[0];
    },
    async runs(sessionId) { return (await pool.query(`SELECT ${runColumns} FROM runs WHERE session_id=$1 ORDER BY created_at`, [sessionId])).rows; },
    async run(id) { return (await pool.query(`SELECT ${runColumns} FROM runs WHERE id=$1`, [id])).rows[0] || null; },
    async ownedRun(id, userId) { return (await pool.query(`SELECT ${leasedRunColumns} FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.id=$1 AND s.user_id=$2`, [id, userId])).rows[0] || null; },
    async createRun(sessionId, prompt, thinkingLevel = null) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(`INSERT INTO runs(id,session_id,prompt,thinking_level) VALUES(gen_random_uuid(),$1,$2,$3) RETURNING ${runColumns}`, [sessionId, prompt, thinkingLevel]);
            await client.query(`UPDATE sessions SET status='queued',updated_at=now() WHERE id=$1`, [sessionId]);
            await client.query('COMMIT');
            return result.rows[0];
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    },
    async events(runId, after = 0) {
        return (await pool.query(`SELECT id::text,run_id AS "runId",kind,title,detail,created_at AS "createdAt" FROM events WHERE run_id=$1 AND id>$2 ORDER BY id`, [runId, after])).rows;
    },
    async addEvent(runId, kind, title, detail) { await pool.query(`INSERT INTO events(run_id,kind,title,detail) VALUES($1,$2,$3,$4)`, [runId, kind, title, detail || null]); },
    async artifacts(runId) { return (await pool.query(`SELECT id,run_id AS "runId",name,kind,path,size_bytes AS "sizeBytes",created_at AS "createdAt" FROM artifacts WHERE run_id=$1`, [runId])).rows; },
    async addArtifact(runId, name, kind, artifactPath, sizeBytes) { await pool.query(`INSERT INTO artifacts(id,run_id,name,kind,path,size_bytes) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)`, [runId, name, kind, artifactPath, sizeBytes]); },
    async setPullRequest(runId, prUrl) { await pool.query(`UPDATE runs SET pr_url=$2 WHERE id=$1`, [runId, prUrl]); },
    async setSessionPullRequest(sessionId, prUrl, prBranch) { await pool.query(`UPDATE sessions SET pr_url=$2,pr_branch=$3,updated_at=now() WHERE id=$1`, [sessionId, prUrl, prBranch]); },
    async setSessionBranch(sessionId, prBranch) { await pool.query(`UPDATE sessions SET pr_url=CASE WHEN pr_branch=$2 THEN pr_url ELSE null END,pr_branch=$2,updated_at=now() WHERE id=$1`, [sessionId, prBranch]); },
    async requestCancel(runId) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(`UPDATE runs
        SET cancel_requested=true,
            status=CASE WHEN status='queued' THEN 'cancelled'::run_status ELSE status END,
            finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END
        WHERE id=$1 AND status IN ('queued','running')
        RETURNING session_id,status`, [runId]);
            const cancelled = result.rows[0];
            if (cancelled?.status === 'cancelled') {
                await client.query(`INSERT INTO events(run_id,kind,title,detail) VALUES($1,'status','Run cancelled','Cancelled before a worker started the task')`, [runId]);
                await client.query(`UPDATE sessions SET
          status=CASE
            WHEN EXISTS (SELECT 1 FROM runs WHERE session_id=$1 AND status='running') THEN 'running'::session_status
            WHEN EXISTS (SELECT 1 FROM runs WHERE session_id=$1 AND status='queued') THEN 'queued'::session_status
            ELSE 'cancelled'::session_status
          END,
          updated_at=now()
          WHERE id=$1`, [cancelled.session_id]);
            }
            await client.query('COMMIT');
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    },
    async leaseRun(workerId) {
        const result = await pool.query(leaseRunSql, [workerId]);
        if (result.rows[0])
            await pool.query(`UPDATE sessions SET status='running',updated_at=now() WHERE id=$1`, [result.rows[0].sessionId]);
        return result.rows[0] || null;
    },
    async heartbeat(runId, workerId) { const r = await pool.query(`UPDATE runs SET lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND worker_id=$2 AND status='running'`, [runId, workerId]); return r.rowCount === 1; },
    async finish(runId, status, summary, error) {
        await pool.query(`WITH done AS (UPDATE runs SET status=$2::text::run_status,summary=$3,error=$4,finished_at=now(),lease_expires_at=null WHERE id=$1 RETURNING session_id) UPDATE sessions SET status=CASE WHEN EXISTS (SELECT 1 FROM runs queued WHERE queued.session_id=done.session_id AND queued.status='queued') THEN 'queued'::session_status ELSE $2::text::session_status END,updated_at=now() FROM done WHERE sessions.id=done.session_id`, [runId, status, summary || null, error || null]);
    }
};
//# sourceMappingURL=db.js.map