import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { db } from './db.js';
import { changedFiles, ensureWorkspace, makeAgentWritable } from './repository.js';
import { vault } from './vault.js';
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
export function runContainerName(runId) { return `relay-run-${runId}`; }
export function codexVolumeName(sessionId) { return `relay-codex-${sessionId}`; }
export async function execute(run, session, signal) {
    const githubToken = session.userId && session.repoUrl?.includes('github.com') ? await vault.getUser(session.userId, 'github_token') : null;
    const openAiKey = session.userId ? await vault.getUser(session.userId, 'openai_api_key') : null;
    const workspace = await ensureWorkspace(session, githubToken);
    await makeAgentWritable(workspace, false);
    const container = await docker.createContainer({
        Image: config.agentImage, name: runContainerName(run.id), Labels: { 'relay.run': run.id, 'relay.session': session.id },
        Env: [`RUN_ID=${run.id}`, `RELAY_SESSION_ID=${session.id}`, `TASK=${run.prompt}`, `AGENT_COUNT=${session.agentCount}`, `OPENAI_API_KEY=${openAiKey || ''}`, `GITHUB_TOKEN=${githubToken || ''}`, `CODEX_MODEL=${process.env.CODEX_MODEL || ''}`, `CODEX_THINKING_LEVEL=${run.thinkingLevel || ''}`, `DIRECT_WORKSPACE=1`],
        WorkingDir: '/workspace', User: '10001:10001',
        HostConfig: { AutoRemove: false, NetworkMode: openAiKey ? 'bridge' : 'none', Memory: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Mounts: [{ Type: 'bind', Source: workspace, Target: '/workspace', ReadOnly: false }, { Type: 'volume', Source: codexVolumeName(session.id), Target: '/home/agent/.codex', ReadOnly: false }] }
    });
    let output = '';
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const sink = new Writable({ write(chunk, _encoding, callback) { output = (output + chunk.toString()).slice(-2_000_000); callback(); } });
    docker.modem.demuxStream(stream, sink, sink);
    const stop = async () => { try {
        await container.stop({ t: 2 });
    }
    catch { } };
    signal.addEventListener('abort', stop, { once: true });
    const streamDone = new Promise((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
    let statusCode;
    try {
        await container.start();
        await db.addEvent(run.id, 'agent', 'Codex process started', 'Isolated run container with persistent session history');
        const [result] = await Promise.all([container.wait(), streamDone]);
        statusCode = result.StatusCode;
    }
    finally {
        signal.removeEventListener('abort', stop);
        try {
            await container.remove({ force: true });
        }
        catch { }
    }
    if (signal.aborted)
        throw new Error('Run cancelled');
    if (statusCode !== 0)
        throw new Error(output.slice(-4000) || `Agent exited ${statusCode}`);
    const codexMarker = output.split('\n').find(line => line.startsWith('RELAY_CODEX:'));
    if (codexMarker)
        await db.addEvent(run.id, 'agent', 'Codex agent verified', codexMarker.slice('RELAY_CODEX:'.length).trim());
    const changes = await changedFiles(workspace);
    if (changes.length)
        await db.addEvent(run.id, 'result', 'Repository files changed', changes.slice(0, 20).join(', '));
    const marker = output.split('\n').find(line => line.startsWith('RELAY_RESULT:'));
    const summary = marker ? marker.slice('RELAY_RESULT:'.length).trim() : 'The agent completed its workspace task.';
    const branchMarker = output.split('\n').filter(line => line.startsWith('RELAY_BRANCH:')).at(-1);
    if (branchMarker) {
        try {
            const observed = JSON.parse(branchMarker.slice('RELAY_BRANCH:'.length));
            if (observed.branch && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(observed.branch) && !observed.branch.includes('..'))
                await db.setSessionBranch(session.id, observed.branch);
        }
        catch { }
    }
    const prMarker = output.split('\n').filter(line => line.startsWith('RELAY_PR:')).at(-1);
    if (prMarker) {
        const published = JSON.parse(prMarker.slice('RELAY_PR:'.length));
        const url = new URL(published.url);
        if (url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) && published.branch) {
            await db.setPullRequest(run.id, published.url);
            await db.setSessionPullRequest(session.id, published.url, published.branch);
            await db.addEvent(run.id, 'publish', 'Pull request published by Codex', published.url);
        }
    }
    return summary;
}
//# sourceMappingURL=runner.js.map