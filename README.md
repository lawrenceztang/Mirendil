# Relay

Relay is a durable cloud coding agent. Connect a repository, describe the outcome, and move on; Relay keeps the workspace and conversation alive outside disposable run containers so you can return to a clear activity trail, answer, or pull request.

- **Fast handoff:** choose one of your GitHub repositories and start a task in a few clicks.
- **Durable context:** each chat keeps its workspace, dependencies, and Codex conversation between runs.
- **Clear delivery:** live activity, cancellation, summaries, branch state, and pull requests stay attached to the chat.
- **Safe questions:** question-only runs leave the repository unchanged and do not create a pull request.

## Quick start

Prerequisites: Docker Desktop with Compose, a Supabase project, and Node.js 20 or newer for local development.

```bash
cp .env.example .env
# Set SUPABASE_URL, SUPABASE_PASSWORD, and the pooler host from Supabase > Connect
docker build -f Dockerfile.agent -t relay-agent:latest .
mkdir -p .relay/workspaces
docker compose up --build
```

Open <http://localhost:3000>, continue with GitHub, and add an OpenAI API key when prompted. GitHub OAuth is both the Relay login and repository authorization: users only receive their own chats, runs, artifacts, and accessible repositories.

Example:

1. Select **Start a chat** and choose `fastify/fastify-example` (or paste its HTTPS URL).
2. Request: `Inspect this project and add a concise CONTRIBUTING.md for first-time contributors.`
3. Leave the page, return to the chat URL, and open the pull request from the completed run.

> Docker Desktop detail: the child run container is created through the host Docker socket. Compose therefore mounts `.relay/workspaces` at the same absolute path inside the worker and on the host. Run Compose from this repository directory; do not relocate it while runs are active.

## Local development

Set the Supabase values in `.env`, then start the API and worker:

```bash
npm ci
npm run db:migrate
npm run dev
# another terminal
npm run dev:worker
```

Run the complete local verification suite:

```bash
npm run verify
```

## Repository map

- `src/` — Fastify API, queue, repository, and container orchestration
- `agent-runtime/` — the isolated Codex entrypoint used inside each temporary run container
- `public/` — dependency-free Relay web interface
- `sql/` — ordered Postgres migrations
- `test/` — Node test suite for auth, queueing, repository safety, and runtime behavior

## Services and configuration

- Supabase Postgres stores sessions, runs, durable events, queue leases, encrypted connection records, and artifact metadata.
- Local Alpine containers encrypt the pooler connection with TLS but disable certificate-chain verification because the pooler chain is not accepted by the image trust store. Production should supply and pin Supabase's database CA.
- Docker hosts one temporary agent container per active run. The worker needs `/var/run/docker.sock` in this prototype; three workers therefore permit at most three simultaneous agent containers.
- Compose starts three worker replicas by default, allowing three concurrent runs. Set `WORKER_REPLICAS` to tune this for available CPU, memory, and model budget.
- Git is required by the worker. Only HTTPS URLs on `ALLOWED_GIT_HOSTS` are accepted.
- OpenAI API keys are encrypted per user and configured from Home, not server environment variables. Each real run invokes `codex exec`; `CODEX_MODEL` can override the CLI's current default model.
- GitHub OAuth establishes the Relay user identity and repository connection. Delegated tokens are encrypted per user and passed only to that user's isolated run container so Codex can choose branches, push, and manage pull requests; executed repository code could access the run credential, an explicit prototype tradeoff.
- Register a GitHub OAuth App with homepage `http://localhost:3000` and callback `http://localhost:3000/api/connections/github/callback`, then set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. The integration requests the `repo` scope so it can clone, push, and create PRs for repositories the authorizing account can access.
- Authentication uses a random 30-day session token stored as a SHA-256 hash in Supabase and an HttpOnly, SameSite=Lax browser cookie. Every session/run/artifact route checks ownership; pre-authentication sessions remain unowned and hidden.
- Workspace files persist in `.relay/workspaces`; application state persists in Supabase.

## API outline

- `POST /api/sessions` creates a workspace.
- `GET /api/sessions/:id` resumes it.
- `POST /api/sessions/:id/runs` queues work.
- `GET /api/events?runId=…` streams durable Server-Sent Events.
- `POST /api/runs/:id/cancel` requests cancellation.
- `GET /api/runs/:runId/artifacts/:artifactId` downloads an artifact.

## Important prototype boundaries

- Repository cloning supports public repositories and private GitHub repositories authorized through OAuth. For production, a GitHub App is preferable because it offers repository-level installation selection and short-lived tokens.
- A user's model key is supplied only to their isolated runtime as an environment variable. Production should replace this with a run-scoped inference proxy so containers never receive provider credentials.
- Relay does not choose or switch Git branches after cloning. Codex owns branch, commit, push, and pull-request decisions; Relay only records the observed branch and PR URL.
- Codex can inspect, edit, and run repository commands autonomously inside the non-root run container. `--dangerously-bypass-approvals-and-sandbox` is safe only because the surrounding container is the security boundary; production still needs seccomp/AppArmor and strict egress controls.
- The Docker socket grants the worker powerful host access. Production should use Kubernetes Jobs, ECS tasks, or a dedicated sandbox service instead.

See [DECISIONS.md](DECISIONS.md) for UX and architecture motivations and the production path.

See [CLOUD_SETUP.md](CLOUD_SETUP.md) for the complete AWS EC2 deployment guide.
