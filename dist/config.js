import path from 'node:path';
export const config = {
    port: Number(process.env.PORT || 3000),
    databaseUrl: process.env.DATABASE_URL || 'postgresql://relay:relay@localhost:5432/relay',
    publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
    workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || '.relay/workspaces'),
    agentImage: process.env.AGENT_IMAGE || 'relay-agent:latest',
    masterKey: process.env.MASTER_KEY || '',
    openAiKey: process.env.OPENAI_API_KEY || '',
    allowedGitHosts: (process.env.ALLOWED_GIT_HOSTS || 'github.com,gitlab.com').split(',').map(x => x.trim()),
    runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS || 15 * 60_000)
};
//# sourceMappingURL=config.js.map