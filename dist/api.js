import path from 'node:path';
import fs from 'node:fs/promises';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { config } from './config.js';
import { db, pool } from './db.js';
import { validateRepoUrl } from './repository.js';
import { vault } from './vault.js';
import { createOAuthState, exchangeGitHubCode, oauthStateMatches, verifyOAuthState } from './github-oauth.js';
import { cookieValue, createLogin, revokeLogin, upsertGitHubUser, userForToken } from './auth.js';
const app = Fastify({ logger: true, bodyLimit: 64_000 });
await app.register(fastifyStatic, { root: path.resolve('public') });
const sessionInput = z.object({ title: z.string().trim().min(1).max(100), repoUrl: z.string().trim().max(500).optional().default(''), branch: z.string().trim().max(120).optional().default(''), agentCount: z.number().int().min(1).max(4).default(1) });
const promptInput = z.object({ prompt: z.string().trim().min(1).max(10_000), thinkingLevel: z.enum(['low', 'medium', 'high', 'xhigh']).nullable().optional().default(null) });
const openAiKeyInput = z.object({ key: z.string().trim().min(20).max(500) });
const authCookie = 'relay_session';
const oauthStateCookie = 'relay_oauth_state';
const secureCookie = config.publicUrl.startsWith('https://') ? '; Secure' : '';
app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/auth/') || req.url.startsWith('/api/connections/github/callback'))
        return;
    const token = cookieValue(req.headers.cookie, authCookie);
    const user = await userForToken(token);
    if (!user)
        return reply.code(401).send({ error: 'Authentication required' });
    req.authUser = user;
    req.authToken = token;
});
app.get('/health', async () => ({ ok: true }));
app.get('/api/auth/github/start', async (_req, reply) => { if (!config.githubClientId)
    return reply.code(503).send({ error: 'GitHub OAuth is not configured' }); const redirectUri = `${config.publicUrl}/api/connections/github/callback`; const state = createOAuthState(); const query = new URLSearchParams({ client_id: config.githubClientId, redirect_uri: redirectUri, scope: 'repo', state, prompt: 'select_account' }); reply.header('Set-Cookie', `${oauthStateCookie}=${encodeURIComponent(state)}; Path=/api/connections/github/callback; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie}`); return reply.redirect(`https://github.com/login/oauth/authorize?${query}`); });
app.get('/api/connections/github/callback', async (req, reply) => { const query = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).parse(req.query); const cookieState = cookieValue(req.headers.cookie, oauthStateCookie); if (!oauthStateMatches(query.state, cookieState))
    return reply.code(400).send({ error: 'Invalid OAuth state' }); verifyOAuthState(query.state); const clearStateCookie = `${oauthStateCookie}=; Path=/api/connections/github/callback; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie}`; if (query.error || !query.code) {
    reply.header('Set-Cookie', clearStateCookie);
    return reply.redirect(config.publicUrl);
} const identity = await exchangeGitHubCode(query.code); const user = await upsertGitHubUser(identity); await vault.putUser(user.id, 'github_token', identity.token); const token = await createLogin(user.id); const loginCookie = `${authCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secureCookie}`; reply.header('Set-Cookie', [clearStateCookie, loginCookie]); return reply.redirect(config.publicUrl); });
app.get('/api/me', async (req) => req.authUser);
app.post('/api/auth/logout', async (req, reply) => { await revokeLogin(req.authToken || null); reply.header('Set-Cookie', `${authCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); return reply.code(204).send(); });
app.get('/api/sessions', async (req) => db.sessions(req.authUser.id));
app.post('/api/sessions', async (req, reply) => { const input = sessionInput.parse(req.body); if (input.repoUrl)
    validateRepoUrl(input.repoUrl); const item = await db.createSession(req.authUser.id, input); return reply.code(201).send(item); });
app.get('/api/sessions/:id', async (req, reply) => { const session = await db.session(req.params.id, req.authUser.id); if (!session)
    return reply.code(404).send({ error: 'Session not found' }); return { session, runs: await db.runs(session.id) }; });
app.get('/api/connections/github', async (req) => ({ connected: true, login: req.authUser.login }));
app.get('/api/connections/github/repos', async (req, reply) => { const token = await vault.getUser(req.authUser.id, 'github_token'); if (!token)
    return reply.code(401).send({ error: 'GitHub authorization missing' }); const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'relay-cloud-agent' } }); if (!response.ok)
    return reply.code(response.status === 401 ? 401 : 502).send({ error: 'Could not load GitHub repositories' }); const repos = await response.json(); return repos.filter(repo => !repo.archived).map(repo => ({ id: repo.id, name: repo.full_name, url: repo.clone_url, private: repo.private, branch: repo.default_branch })); });
app.get('/api/connections/openai', async (req) => ({ configured: Boolean(await vault.getUser(req.authUser.id, 'openai_api_key')) }));
app.put('/api/connections/openai', async (req, reply) => { const { key } = openAiKeyInput.parse(req.body); const validation = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }); if (!validation.ok)
    return reply.code(400).send({ error: validation.status === 401 ? 'OpenAI rejected this API key. Create a valid key at platform.openai.com.' : 'Could not validate this OpenAI key.' }); await vault.putUser(req.authUser.id, 'openai_api_key', key); return reply.code(204).send(); });
app.delete('/api/connections/openai', async (req, reply) => { await pool.query(`DELETE FROM user_connections WHERE user_id=$1 AND name='openai_api_key'`, [req.authUser.id]); return reply.code(204).send(); });
app.post('/api/sessions/:id/runs', async (req, reply) => { if (!await db.session(req.params.id, req.authUser.id))
    return reply.code(404).send({ error: 'Session not found' }); const { prompt, thinkingLevel } = promptInput.parse(req.body); return reply.code(202).send(await db.createRun(req.params.id, prompt, thinkingLevel)); });
app.get('/api/runs/:id', async (req, reply) => { const run = await db.ownedRun(req.params.id, req.authUser.id); if (!run)
    return reply.code(404).send({ error: 'Run not found' }); return { run, events: await db.events(run.id), artifacts: await db.artifacts(run.id) }; });
app.post('/api/runs/:id/cancel', async (req, reply) => { if (!await db.ownedRun(req.params.id, req.authUser.id))
    return reply.code(404).send({ error: 'Run not found' }); await db.requestCancel(req.params.id); return reply.code(202).send({ ok: true }); });
app.get('/api/runs/:runId/artifacts/:artifactId', async (req, reply) => { if (!await db.ownedRun(req.params.runId, req.authUser.id))
    return reply.code(404).send({ error: 'Artifact not found' }); const item = (await db.artifacts(req.params.runId)).find(x => x.id === req.params.artifactId); if (!item)
    return reply.code(404).send({ error: 'Artifact not found' }); const data = await fs.readFile(item.path); return reply.header('Content-Type', item.kind === 'diff' ? 'text/x-diff' : 'application/octet-stream').header('Content-Disposition', `attachment; filename="${item.name.replaceAll('"', '')}"`).send(data); });
app.get('/api/events', async (req, reply) => {
    const q = z.object({ runId: z.string().uuid(), after: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    if (!await db.ownedRun(q.runId, req.authUser.id))
        return reply.code(404).send({ error: 'Run not found' });
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
app.setErrorHandler((error, req, reply) => { const known = error; const status = error instanceof z.ZodError ? 400 : known.statusCode || 500; if (status === 500)
    req.log.error(error); reply.code(status).send({ error: status === 500 ? 'Unexpected server error' : known.message || 'Invalid request' }); });
app.addHook('onClose', async () => { await pool.end(); });
await app.listen({ port: config.port, host: '0.0.0.0' });
//# sourceMappingURL=api.js.map