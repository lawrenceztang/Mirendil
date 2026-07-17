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
export async function ensureWorkspace(session) {
    const dir = path.join(config.workspaceRoot, session.id);
    await fs.mkdir(config.workspaceRoot, { recursive: true });
    try {
        await fs.access(path.join(dir, '.git'));
        return dir;
    }
    catch { }
    await fs.mkdir(dir, { recursive: true });
    if (!session.repoUrl) {
        await command('git', ['init'], dir);
        await fs.writeFile(path.join(dir, 'README.md'), '# New Relay workspace\n');
        return dir;
    }
    const url = validateRepoUrl(session.repoUrl);
    const args = ['clone', '--depth=1'];
    if (session.branch)
        args.push('--branch', session.branch);
    args.push(url.toString(), '.');
    await command('git', args, dir, 300_000);
    return dir;
}
export async function diff(workspace) {
    const tracked = await command('git', ['diff', '--no-ext-diff', '--'], workspace);
    const untracked = await command('git', ['ls-files', '--others', '--exclude-standard'], workspace);
    let result = tracked;
    for (const file of untracked.split('\n').filter(Boolean).slice(0, 30)) {
        try {
            result += `\n--- /dev/null\n+++ b/${file}\n` + (await fs.readFile(path.join(workspace, file), 'utf8')).split('\n').map(x => `+${x}`).join('\n');
        }
        catch { }
    }
    return result.slice(0, 500_000);
}
//# sourceMappingURL=repository.js.map