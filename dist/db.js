import pg from 'pg';
import { config } from './config.js';
const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const sessionColumns = `id, title, repo_url AS "repoUrl", branch, agent_count AS "agentCount", status, created_at AS "createdAt", updated_at AS "updatedAt"`;
const runColumns = `id, session_id AS "sessionId", prompt, status, summary, error, cancel_requested AS "cancelRequested", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"`;
export const db = {
    async sessions() { return (await pool.query(`SELECT ${sessionColumns} FROM sessions ORDER BY updated_at DESC`)).rows; },
    async session(id) { return (await pool.query(`SELECT ${sessionColumns} FROM sessions WHERE id=$1`, [id])).rows[0] || null; },
    async createSession(input) {
        return (await pool.query(`INSERT INTO sessions(id,title,repo_url,branch,agent_count) VALUES(gen_random_uuid(),$1,$2,$3,$4) RETURNING ${sessionColumns}`, [input.title, input.repoUrl || null, input.branch || null, input.agentCount])).rows[0];
    },
    async runs(sessionId) { return (await pool.query(`SELECT ${runColumns} FROM runs WHERE session_id=$1 ORDER BY created_at`, [sessionId])).rows; },
    async run(id) { return (await pool.query(`SELECT ${runColumns} FROM runs WHERE id=$1`, [id])).rows[0] || null; },
    async createRun(sessionId, prompt) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(`INSERT INTO runs(id,session_id,prompt) VALUES(gen_random_uuid(),$1,$2) RETURNING ${runColumns}`, [sessionId, prompt]);
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
    async requestCancel(runId) { await pool.query(`UPDATE runs SET cancel_requested=true WHERE id=$1 AND status IN ('queued','running')`, [runId]); },
    async leaseRun(workerId) {
        const result = await pool.query(`WITH next AS (SELECT id FROM runs WHERE status='queued' OR (status='running' AND lease_expires_at<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE runs r SET status='running',worker_id=$1,lease_expires_at=now()+interval '30 seconds',started_at=COALESCE(started_at,now()) FROM next WHERE r.id=next.id RETURNING ${runColumns}`, [workerId]);
        if (result.rows[0])
            await pool.query(`UPDATE sessions SET status='running',updated_at=now() WHERE id=$1`, [result.rows[0].sessionId]);
        return result.rows[0] || null;
    },
    async heartbeat(runId, workerId) { const r = await pool.query(`UPDATE runs SET lease_expires_at=now()+interval '30 seconds' WHERE id=$1 AND worker_id=$2 AND status='running'`, [runId, workerId]); return r.rowCount === 1; },
    async finish(runId, status, summary, error) {
        await pool.query(`WITH done AS (UPDATE runs SET status=$2,summary=$3,error=$4,finished_at=now(),lease_expires_at=null WHERE id=$1 RETURNING session_id) UPDATE sessions SET status=$2,updated_at=now() FROM done WHERE sessions.id=done.session_id`, [runId, status, summary || null, error || null]);
    }
};
//# sourceMappingURL=db.js.map