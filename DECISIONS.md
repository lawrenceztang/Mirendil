# UX and architecture decisions

## Product thesis

The essential value is not a clever chat completion; it is trustworthy delegation. Relay therefore optimizes for three moments: handing off a task in under a minute, understanding what is happening without reading raw logs, and returning hours later to an unambiguous result.

## UX

Sessions have stable hash URLs, live in a recent-chats sidebar, and expose explicit queued, running, completed, failed, cancelled, and interrupted states. A run renders as the original request followed by a task-level event trail, final summary, and pull-request link. Events show actions such as preparing the workspace without exposing hidden chain-of-thought.

Creating a chat asks only for a repository, selected from the signed-in GitHub account or entered as an HTTPS URL. Branch, worker, credential, and deployment details stay out of the task flow.

The UI uses Server-Sent Events because progress is server-to-client and reconnection is built in. Durable events remain queryable after the stream closes, so SSE is an optimization rather than the source of truth.

## Persistence and recovery

PostgreSQL owns both product state and queue state. A worker atomically leases the oldest queued run with `FOR UPDATE SKIP LOCKED`, renews a 30-second lease, and lets another worker reclaim an expired run. This avoids adding Redis solely for a small queue while preserving horizontal worker scaling.

The current runtime restarts reclaimed work from the durable workspace rather than resuming a process instruction-by-instruction. Exact process continuation is fragile; restarting from a known workspace is simpler to reason about. In production, each tool call would have an idempotency key and checkpoint so the lead agent can reconstruct context safely.

Workspaces live outside containers on persistent storage so Codex edits survive run-container exit. Relay detects changed filenames, commits the workspace directly, and opens a draft pull request without generating a parallel patch artifact.

## Isolation and secrets

Each run gets a fresh non-root Docker container with dropped Linux capabilities, `no-new-privileges`, and PID/CPU/memory limits. The trusted repository is mounted read-only and copied into the container's private filesystem. After success, Relay validates file count, total size, types, symlinks, and exclusion of `.git` before importing the output. Demo runs have no network; model-enabled runs currently use bridge networking.

GitHub OAuth provides both Relay identity and repository authorization with signed, expiring state. Login tokens are hashed; delegated GitHub tokens are encrypted per user and omitted from logs/model context. Every chat, run, event stream, cancellation, and artifact lookup is ownership-filtered. Git credentials are applied through process-scoped authorization headers rather than repository configuration. A production GitHub App would further improve repository selection and token lifetime.

Users supply their own provider key, encrypted under the server master key and scoped by Relay user ID. Passing it into the matching run container is a conscious prototype compromise. The production design uses a one-run signed token accepted by an inference proxy, keeping the provider credential outside the sandbox.

## Parallel agents

Each queue worker owns one run at a time and launches one Codex agent container. Worker replicas provide safe parallelism across separate runs; a single repository run has one writer, avoiding conflicting edits inside the same workspace.

## Code choices

The API and worker are separate entry points but share strict TypeScript domain/database modules. Fastify offers a small, typed HTTP surface. Zod validates data at trust boundaries. SQL is explicit because the lease query is central behavior worth seeing and reviewing. The frontend is dependency-free JavaScript/CSS to keep the submission focused on the cloud-agent system.

The runtime uses non-interactive `codex exec`, allowing iterative repository inspection, edits, and verification commands. Codex bypasses inner approval prompts because the disposable container is the outer security boundary. Copy-in/copy-out keeps trusted host Git metadata outside Codex's writable filesystem. URL allowlisting prevents `file:`, SSH command injection, and obvious clone-based SSRF paths.

## Hosting

For a small deployment: managed PostgreSQL, one API service, one or more worker services, private object storage, and a sandbox provider. On AWS, the worker would launch one ECS/Fargate task per run and mount EFS or fetch/publish a workspace snapshot from S3. Kubernetes Jobs are the equivalent on a cluster. The API can scale independently because it owns no in-memory run state.

## What I would do next

1. GitHub App installation, scoped clone/push, and draft PR creation.
2. Run-scoped model proxy and KMS envelope encryption.
3. True read-only investigator fan-out plus lead synthesis.
4. Sandboxed command/test tool with egress policy and seccomp.
5. Authentication, tenant isolation, quotas, audit trail, and artifact retention.
6. Browser tests covering refresh, cancellation, expired leases, and reconnect.

The scope intentionally favors a complete durable lifecycle over a broad but partially secured tool catalog.
