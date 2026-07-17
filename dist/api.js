import path from 'node:path';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { config } from './config.js';
import { db, pool } from './db.js';
import { validateRepoUrl } from './repository.js';
const app = Fastify({ logger: true, bodyLimit: 64_000 });
await app.register(fastifyStatic, { root: path.resolve('public') });
const sessionInput = z.object({ title: z.string().trim().min(1).max(100), repoUrl: z.string().trim().max(500).optional().default(''), branch: z.string().trim().max(120).optional().default(''), agentCount: z.number().int().min(1).max(4).default(1) });
const promptInput = z.object({ prompt: z.string().trim().min(3).max(10_000) });
app.get('/health', async () => ({ ok: true }));
app.get('/api/sessions', async () => db.sessions());
app.post('/api/sessions', async (req, reply) => { const input = sessionInput.parse(req.body); if (input.repoUrl)
    validateRepoUrl(input.repoUrl); const item = await db.createSession(input); return reply.code(201).send(item); });
app.get('/api/sessions/:id', async (req, reply) => { const session = await db.session(req.params.id); if (!session)
    return reply.code(404).send({ error: 'Session not found' }); return { session, runs: await db.runs(session.id) }; });
app.post('/api/sessions/:id/runs', async (req, reply) => { if (!await db.session(req.params.id))
    return reply.code(404).send({ error: 'Session not found' }); const { prompt } = promptInput.parse(req.body); return reply.code(202).send(await db.createRun(req.params.id, prompt)); });
app.get('/api/runs/:id', async (req, reply) => { const run = await db.run(req.params.id); if (!run)
    return reply.code(404).send({ error: 'Run not found' }); return { run, events: await db.events(run.id), artifacts: await db.artifacts(run.id) }; });
app.post('/api/runs/:id/cancel', async (req, reply) => { await db.requestCancel(req.params.id); return reply.code(202).send({ ok: true }); });
app.get('/api/runs/:runId/artifacts/:artifactId', async (req, reply) => { const item = (await db.artifacts(req.params.runId)).find(x => x.id === req.params.artifactId); if (!item)
    return reply.code(404).send({ error: 'Artifact not found' }); const data = await fs.readFile(item.path); return reply.header('Content-Type', item.kind === 'diff' ? 'text/x-diff' : 'application/octet-stream').header('Content-Disposition', `attachment; filename="${item.name.replaceAll('"', '')}"`).send(data); });
app.get('/api/events', async (req, reply) => {
    const q = z.object({ runId: z.string().uuid(), after: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    let after = q.after;
    const timer = setInterval(async () => { const events = await db.events(q.runId, after); for (const event of events) {
        after = Number(event.id);
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    } const run = await db.run(q.runId); if (!run || ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
        reply.raw.write(`event: done\ndata: ${JSON.stringify(run)}\n\n`);
        clearInterval(timer);
        reply.raw.end();
    } }, 1000);
    req.raw.on('close', () => clearInterval(timer));
    return reply;
});
app.setErrorHandler((error, _req, reply) => { const known = error; const status = error instanceof z.ZodError ? 400 : known.statusCode || 500; reply.code(status).send({ error: status === 500 ? 'Unexpected server error' : known.message || 'Invalid request' }); });
app.addHook('onClose', async () => { await pool.end(); });
await app.listen({ port: config.port, host: '0.0.0.0' });
//# sourceMappingURL=api.js.map