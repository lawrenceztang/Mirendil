import crypto from 'node:crypto';
import { config } from './config.js';
import { db, pool } from './db.js';
import { execute } from './runner.js';
const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;
console.log(`${workerId} ready`);
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
while (!stopping) {
    const run = await db.leaseRun(workerId);
    if (!run) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
    }
    const session = await db.session(run.sessionId);
    if (!session) {
        await db.finish(run.id, 'failed', undefined, 'Session missing');
        continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.runTimeoutMs);
    const heartbeat = setInterval(async () => {
        const current = await db.run(run.id);
        if (current?.cancelRequested)
            controller.abort();
        else if (!await db.heartbeat(run.id, workerId))
            controller.abort();
    }, 10_000);
    try {
        await db.addEvent(run.id, 'status', 'Run started');
        const summary = await execute(run, session, controller.signal);
        await db.finish(run.id, 'completed', summary);
        await db.addEvent(run.id, 'status', 'Run completed', summary);
    }
    catch (error) {
        const cancelled = (await db.run(run.id))?.cancelRequested || controller.signal.aborted;
        const message = error instanceof Error ? error.message : String(error);
        await db.finish(run.id, cancelled ? 'cancelled' : 'failed', undefined, message);
        await db.addEvent(run.id, 'error', cancelled ? 'Run cancelled' : 'Run failed', message);
    }
    finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
    }
}
await pool.end();
//# sourceMappingURL=worker.js.map