# ***Relay is in production at http://98.90.195.242:3000/***

# Run Relay on macOS

## 1. Install Git and Docker

```bash
xcode-select --install
```

Install and open [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/). Wait until Docker reports that the engine is running.

Verify the commands available on your Mac:

```bash
git --version
docker --version
docker-compose version || docker compose version
docker run --rm hello-world
```

These instructions use `docker-compose`. If only `docker compose version` works on your Mac, replace `docker-compose` with `docker compose` in the commands below.

## 2. Create a GitHub OAuth App

1. Open [https://github.com/settings/developers](https://github.com/settings/developers).
2. Select **OAuth Apps → New OAuth App**.
3. Enter:

```text
Application name: Relay local
Homepage URL: http://localhost:3000
Authorization callback URL: http://localhost:3000/api/connections/github/callback
```

1. Select **Register application**.
2. Generate a client secret.
3. Save the client ID and client secret.



## 3. Create the Supabase database

1. Open [https://supabase.com/dashboard](https://supabase.com/dashboard) and select **New project**.
2. Choose a project name, region, and database password.
3. Wait for the project to finish provisioning.
4. Select **Connect → Session pooler**.
5. Copy the PostgreSQL URL that uses port `5432`.
6. Replace `[YOUR-PASSWORD]` with the project database password.
7. Save the completed URL.



## 4. Create an OpenAI API key

1. Configure API billing at [https://platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing).
2. Open [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. Select **Create new secret key** and save it.



## 5. Clone and configure Relay

```bash
git clone https://github.com/lawrenceztang/Mirendil
cd Mirendil
cp .env.example .env
openssl rand -hex 32
```

Put the generated key and saved credentials into `.env`:

```env
PUBLIC_URL=http://localhost:3000
SUPABASE_DATABASE_URL=YOUR_COMPLETED_SESSION_POOLER_URL
MASTER_KEY=OUTPUT_FROM_OPENSSL
GITHUB_CLIENT_ID=YOUR_OAUTH_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_OAUTH_CLIENT_SECRET
```



## 6. Build the Codex agent

```bash
mkdir -p .relay/workspaces
docker build -f Dockerfile.agent -t relay-agent:latest .
```



## 7. Create the Supabase schema

Run Relay's ordered SQL migrations against the configured Supabase database:

```bash
docker-compose run --rm --build migrate
```

The first run prints `Applied 001_initial.sql` followed by the remaining migration names. Later runs are safe and exit without reapplying completed migrations.

## 8. Start Relay

```bash
docker-compose up -d --build web worker
docker-compose ps
docker-compose logs --tail=100 web worker
```

The web container and three worker containers should show `Up`. Each worker log should end in `ready`.

## 9. Run a task

1. Open [http://localhost:3000](http://localhost:3000).
2. Sign in with GitHub.
3. Enter the OpenAI API key from step 4.
4. Select a GitHub repository that the signed-in account can push to. Relay needs write access to create branches and pull requests.
5. Start a chat with:

```text
Add a concise CONTRIBUTING.md for first-time contributors.
```
