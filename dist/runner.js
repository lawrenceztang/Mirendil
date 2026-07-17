import Docker from 'dockerode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { config } from './config.js';
import { db } from './db.js';
import { diff, ensureWorkspace } from './repository.js';
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
export async function execute(run, session, signal) {
    await db.addEvent(run.id, 'setup', 'Preparing isolated workspace', session.repoUrl || 'Blank git workspace');
    const workspace = await ensureWorkspace(session);
    await db.addEvent(run.id, 'setup', 'Starting agent container', `${config.agentImage} · ${session.agentCount} agent${session.agentCount === 1 ? '' : 's'}`);
    const container = await docker.createContainer({
        Image: config.agentImage,
        name: `relay-${run.id}`,
        Env: [`RUN_ID=${run.id}`, `TASK=${run.prompt}`, `AGENT_COUNT=${session.agentCount}`, `OPENAI_API_KEY=${config.openAiKey}`, `OPENAI_MODEL=${process.env.OPENAI_MODEL || 'gpt-4.1-mini'}`],
        WorkingDir: '/workspace', User: '10001:10001',
        HostConfig: { AutoRemove: true, NetworkMode: config.openAiKey ? 'bridge' : 'none', Memory: 1024 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Mounts: [{ Type: 'bind', Source: workspace, Target: '/workspace', ReadOnly: false }] }
    });
    let output = '';
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
    docker.modem.demuxStream(stream, sink, sink);
    const stop = async () => { try {
        await container.stop({ t: 2 });
    }
    catch { } };
    signal.addEventListener('abort', stop, { once: true });
    await container.start();
    const result = await container.wait();
    signal.removeEventListener('abort', stop);
    if (signal.aborted)
        throw new Error('Run cancelled');
    if (result.StatusCode !== 0)
        throw new Error(output.slice(-4000) || `Agent exited ${result.StatusCode}`);
    const patch = await diff(workspace);
    if (patch) {
        const file = path.join(workspace, '.relay-diff.patch');
        await fs.writeFile(file, patch);
        await db.addArtifact(run.id, 'Changes.patch', 'diff', file, Buffer.byteLength(patch));
        await db.addEvent(run.id, 'result', 'Changes ready', `${patch.split('\n').length} diff lines`);
    }
    const marker = output.split('\n').find(line => line.startsWith('RELAY_RESULT:'));
    return marker ? marker.slice('RELAY_RESULT:'.length).trim() : 'The agent completed its workspace task.';
}
//# sourceMappingURL=runner.js.map