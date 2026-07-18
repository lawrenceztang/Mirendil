# Relay

Relay is a durable cloud coding agent that turns repository tasks into reviewable pull requests. Connect a GitHub repository, describe an outcome, and follow the work as Relay inspects the codebase, makes changes in an isolated container, runs checks, and publishes the result.

## What Relay does

- Keeps each chat scoped to a GitHub repository.
- Runs coding tasks in isolated Docker containers.
- Streams progress and results to the browser in real time.
- Reuses chat context across follow-up tasks.
- Runs repository checks before presenting the result.
- Creates or updates pull requests with completed work.
- Encrypts stored OpenAI credentials and never displays them again.

## How it works

The Fastify web service handles authentication, chat sessions, and the browser UI. PostgreSQL stores durable session and run state. Workers claim queued runs and launch the agent runtime inside Docker, with a persistent Codex volume for each chat. GitHub OAuth provides repository access, while server-sent events deliver live activity to the frontend.

```text
Browser → Fastify API → PostgreSQL queue → Worker → Isolated agent container
   ↑                                                          │
   └──────────── live activity and pull-request result ────────┘
```

## Local setup

### Prerequisites

- Docker with Docker Compose
- Git
- A Supabase project
- A GitHub OAuth App
- Node.js 20 or newer for non-Docker development

### 1. Configure the repository

```bash
git clone https://github.com/lawrenceztang/Mirendil
cd Mirendil
cp .env.example .env
openssl rand -hex 32
```

Open `.env` and configure:

```env
PUBLIC_URL=http://localhost:3000

SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PASSWORD=YOUR_DATABASE_PASSWORD
SUPABASE_DATABASE_URL=YOUR_SESSION_POOLER_URL

MASTER_KEY=OUTPUT_FROM_OPENSSL

GITHUB_CLIENT_ID=YOUR_OAUTH_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_OAUTH_CLIENT_SECRET
```

Copy the Session pooler URL from **Supabase → Connect** and replace its password placeholder with the project database password.

### 2. Configure GitHub OAuth

Create an OAuth App at <https://github.com/settings/developers> with:

```text
Homepage URL:
http://localhost:3000

Authorization callback URL:
http://localhost:3000/api/connections/github/callback
```

Copy its client ID and client secret into `.env`.

### 3. Build and start with Docker

```bash
mkdir -p .relay/workspaces
docker build -f Dockerfile.agent -t relay-agent:latest .
docker compose up -d --build
```

If the Compose plugin is unavailable, replace `docker compose` with `docker-compose`.

Check startup:

```bash
docker compose ps
docker compose logs --tail=100 migrate web worker
```

The migration container should exit successfully. The web container and three workers should remain running.

Open <http://localhost:3000>, sign in with GitHub, and add your OpenAI API key from the home page.

Try:

```text
Repository: https://github.com/fastify/fastify-example.git
Request: Add a concise CONTRIBUTING.md for first-time contributors.
```

### 4. Run without the web/worker Compose containers

Docker must still be running because workers launch agent containers.

```bash
npm ci
docker build -f Dockerfile.agent -t relay-agent:latest .
npm run db:migrate
npm run dev
```

In another terminal:

```bash
npm run dev:worker
```

### 5. Verify the repository

```bash
npm run verify
```

### 6. Stop or rebuild

Stop local services without deleting persistent volumes:

```bash
docker compose down
```

Rebuild after application changes:

```bash
docker compose up -d --build --force-recreate web worker
```

Rebuild the agent after changing `Dockerfile.agent` or `agent-runtime/`:

```bash
docker build -f Dockerfile.agent -t relay-agent:latest .
docker compose up -d --build --force-recreate worker
```

For AWS EC2 setup, HTTPS, OAuth production URLs, disk recovery, and EBS resizing, follow [CLOUD_SETUP.md](CLOUD_SETUP.md).
