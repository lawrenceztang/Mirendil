import path from 'node:path';

function databaseUrl(): string {
  const supabaseUrl=process.env.SUPABASE_URL;const password=process.env.SUPABASE_PASSWORD;
  if(process.env.SUPABASE_DATABASE_URL)return process.env.SUPABASE_DATABASE_URL;
  if(process.env.DIRECT_URL){const value=process.env.DIRECT_URL;if(password&&/\[(?:YOUR-)?PASSWORD\]/i.test(value)){const url=new URL(value);url.password=password;return url.toString();}return value;}
  if(process.env.DATABASE_URL){const value=process.env.DATABASE_URL;if(password&&/\[(?:YOUR-)?PASSWORD\]/i.test(value)){const url=new URL(value);url.password=password;return url.toString();}return value;}
  if(supabaseUrl&&password){const project=new URL(supabaseUrl).hostname.split('.')[0];const host=process.env.SUPABASE_DB_HOST;if(!project)throw new Error('Invalid SUPABASE_URL');if(!host)throw new Error('SUPABASE_DB_HOST is required; copy the Session pooler host from Supabase > Connect');const port=process.env.SUPABASE_DB_PORT||'5432';return `postgresql://postgres.${project}:${encodeURIComponent(password)}@${host}:${port}/postgres`;}
  return 'postgresql://relay:relay@localhost:5432/relay';
}

const resolvedDatabaseUrl=databaseUrl();
export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: resolvedDatabaseUrl,
  isSupabase: resolvedDatabaseUrl.includes('.supabase.com'),
  publicUrl: process.env.PUBLIC_URL || 'http://localhost:3000',
  workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT || '.relay/workspaces'),
  agentImage: process.env.AGENT_IMAGE || 'relay-agent:latest',
  masterKey: process.env.MASTER_KEY || '',
  githubClientId: process.env.GITHUB_CLIENT_ID || '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET || '',
  allowedGitHosts: (process.env.ALLOWED_GIT_HOSTS || 'github.com,gitlab.com').split(',').map(x => x.trim()),
  runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS || 15 * 60_000)
};
