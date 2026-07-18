export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Session {
  id: string; userId: string|null; title: string; repoUrl: string | null; branch: string | null;
  agentCount: number; status: RunStatus | 'idle'; prUrl:string|null; prBranch:string|null; createdAt: string; updatedAt: string;
}
export interface Run {
  id: string; sessionId: string; prompt: string; status: RunStatus; summary: string | null;
  error: string | null; prUrl: string | null; thinkingLevel: string | null; cancelRequested: boolean; createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface RunEvent { id: string; runId: string; kind: string; title: string; detail: string | null; createdAt: string; }
export interface Artifact { id: string; runId: string; name: string; kind: string; path: string; sizeBytes: number; createdAt: string; }
