import crypto from 'node:crypto';
import { pool } from './db.js';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function cookieValue(header, name) {
    for (const part of (header || '').split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name)
            return decodeURIComponent(value.join('='));
    }
    return null;
}
export async function userForToken(token) { if (!token)
    return null; const result = await pool.query(`SELECT u.id,u.login,u.avatar_url AS "avatarUrl" FROM auth_sessions a JOIN users u ON u.id=a.user_id WHERE a.token_hash=$1 AND a.expires_at>now()`, [hash(token)]); return result.rows[0] || null; }
export async function upsertGitHubUser(identity) { return (await pool.query(`INSERT INTO users(github_id,login,avatar_url) VALUES($1,$2,$3) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,avatar_url=excluded.avatar_url,updated_at=now() RETURNING id,login,avatar_url AS "avatarUrl"`, [identity.id, identity.login, identity.avatarUrl])).rows[0]; }
export async function createLogin(userId) { const token = crypto.randomBytes(32).toString('base64url'); await pool.query(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')`, [hash(token), userId]); return token; }
export async function revokeLogin(token) { if (token)
    await pool.query(`DELETE FROM auth_sessions WHERE token_hash=$1`, [hash(token)]); }
//# sourceMappingURL=auth.js.map