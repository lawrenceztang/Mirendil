import crypto from 'node:crypto';
import { config } from './config.js';
import { pool } from './db.js';
function key() {
    if (config.masterKey.length < 32)
        throw new Error('MASTER_KEY must contain at least 32 characters to store connections');
    return crypto.createHash('sha256').update(config.masterKey).digest();
}
export const vault = {
    async put(sessionId, name, value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
        cipher.setAAD(Buffer.from(`${sessionId}:${name}`));
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const record = [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.');
        await pool.query(`INSERT INTO secrets(session_id,name,encrypted_value) VALUES($1,$2,$3) ON CONFLICT(session_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,created_at=now()`, [sessionId, name, record]);
    },
    async get(sessionId, name) {
        const record = (await pool.query(`SELECT encrypted_value FROM secrets WHERE session_id=$1 AND name=$2`, [sessionId, name])).rows[0]?.encrypted_value;
        if (!record)
            return null;
        const [iv, tag, data] = String(record).split('.');
        if (!iv || !tag || !data)
            throw new Error('Stored connection is corrupt');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
        decipher.setAAD(Buffer.from(`${sessionId}:${name}`));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
    async has(sessionId, name) { return Boolean((await pool.query(`SELECT 1 FROM secrets WHERE session_id=$1 AND name=$2`, [sessionId, name])).rowCount); },
    async remove(sessionId, name) { await pool.query(`DELETE FROM secrets WHERE session_id=$1 AND name=$2`, [sessionId, name]); },
    async putGlobal(name, value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
        cipher.setAAD(Buffer.from(`global:${name}`));
        const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const record = [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.');
        await pool.query(`INSERT INTO connections(name,encrypted_value) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET encrypted_value=excluded.encrypted_value,created_at=now()`, [name, record]);
    },
    async getGlobal(name) { const record = (await pool.query(`SELECT encrypted_value FROM connections WHERE name=$1`, [name])).rows[0]?.encrypted_value; if (!record)
        return null; const [iv, tag, data] = String(record).split('.'); if (!iv || !tag || !data)
        throw new Error('Stored connection is corrupt'); const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); decipher.setAAD(Buffer.from(`global:${name}`)); decipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'); },
    async hasGlobal(name) { return Boolean((await pool.query(`SELECT 1 FROM connections WHERE name=$1`, [name])).rowCount); },
    async removeGlobal(name) { await pool.query(`DELETE FROM connections WHERE name=$1`, [name]); },
    async putUser(userId, name, value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(Buffer.from(`${userId}:${name}`)); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); const record = [iv, cipher.getAuthTag(), data].map(x => x.toString('base64')).join('.'); await pool.query(`INSERT INTO user_connections(user_id,name,encrypted_value) VALUES($1,$2,$3) ON CONFLICT(user_id,name) DO UPDATE SET encrypted_value=excluded.encrypted_value,created_at=now()`, [userId, name, record]); },
    async getUser(userId, name) { const record = (await pool.query(`SELECT encrypted_value FROM user_connections WHERE user_id=$1 AND name=$2`, [userId, name])).rows[0]?.encrypted_value; if (!record)
        return null; const [iv, tag, data] = String(record).split('.'); if (!iv || !tag || !data)
        throw new Error('Stored connection is corrupt'); const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64')); decipher.setAAD(Buffer.from(`${userId}:${name}`)); decipher.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'); }
};
//# sourceMappingURL=vault.js.map