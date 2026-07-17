import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from './db.js';
await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
for (const name of (await fs.readdir(path.resolve('sql'))).filter(x => x.endsWith('.sql')).sort()) {
    if ((await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(await fs.readFile(path.resolve('sql', name), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
        console.log(`Applied ${name}`);
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
}
await pool.end();
//# sourceMappingURL=migrate.js.map