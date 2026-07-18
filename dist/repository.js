import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
export function validateRepoUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !config.allowedGitHosts.includes(url.hostname))
        throw new Error(`Only HTTPS repositories on ${config.allowedGitHosts.join(', ')} are allowed`);
    if (url.username || url.password)
        throw new Error('Do not put credentials in repository URLs');
    return url;
}
export function command(command, args, cwd, timeout = 120_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        child.stdout.on('data', d => { if (out.length < 2_000_000)
            out += d; });
        child.stderr.on('data', d => { if (err.length < 200_000)
            err += d; });
        child.on('error', reject);
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${command} exited ${code}`)); });
    });
}
export async function ensureWorkspace(session, githubToken) {
    const dir = path.join(config.workspaceRoot, session.id);
    await fs.mkdir(config.workspaceRoot, { recursive: true });
    let exists = true;
    try {
        await fs.access(path.join(dir, '.git'));
    }
    catch {
        exists = false;
    }
    if (exists)
        return dir;
    await fs.mkdir(dir, { recursive: true });
    if (!session.repoUrl) {
        await command('git', ['init'], dir);
        await fs.writeFile(path.join(dir, 'README.md'), '# New Relay workspace\n');
        return dir;
    }
    const url = validateRepoUrl(session.repoUrl);
    const args = [];
    if (githubToken && url.hostname === 'github.com')
        args.push('-c', `http.${url.origin}/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`);
    args.push('clone', '--depth=1');
    if (session.branch)
        args.push('--branch', session.branch);
    args.push(url.toString(), '.');
    await command('git', args, dir, 300_000);
    return dir;
}
export async function changedFiles(workspace) { const output = await command('git', ['-c', `safe.directory=${workspace}`, 'status', '--porcelain', '--untracked-files=all'], workspace); return output.split('\n').filter(Boolean).map(line => line.slice(3)).filter(file => file !== '.relay-diff.patch'); }
export async function makeAgentWritable(workspace, includeDependencies = true) {
    async function visit(current) {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
            return;
        if (stat.isDirectory())
            for (const entry of await fs.readdir(current)) {
                if (!includeDependencies && entry === 'node_modules')
                    continue;
                await visit(path.join(current, entry));
            }
        await fs.chmod(current, stat.mode | (stat.isDirectory() ? 0o777 : 0o666));
    }
    await visit(workspace);
}
//# sourceMappingURL=repository.js.map