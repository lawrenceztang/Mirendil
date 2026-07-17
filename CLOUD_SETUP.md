# Cloud setup

This guide deploys Relay to a single AWS EC2 instance. The API and workers run on the VM, temporary Codex containers run through its Docker daemon, and application data remains in Supabase.

## Quick redeploy

For normal API, UI, worker, or Compose changes:

```bash
cd ~/mirendil
git pull
docker compose up -d --build --force-recreate web worker
```

Verify the production URL reached the web container:

```bash
docker compose exec web printenv PUBLIC_URL
```

If `Dockerfile.agent` or anything in `agent-runtime/` changed, rebuild the Codex image too:

```bash
cd ~/mirendil
git pull
docker build --no-cache -f Dockerfile.agent -t relay-agent:latest .
docker compose up -d --build --force-recreate worker
```

Check the deployment:

```bash
docker compose ps
docker compose logs --tail=100 web worker
```

## 1. Instance requirements

Recommended starting size:

- Ubuntu 24.04 or Amazon Linux 2023
- 4 vCPU and 8 GB RAM for three concurrent workers
- 80 GB persistent disk
- A public IPv4 address

## 2. Install Docker and Git

### Ubuntu

```bash
sudo apt update
sudo apt install -y docker.io docker-compose git
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

If Compose V2 is installed, use `docker compose` instead of `docker-compose` in the commands below.

## 3. Copy Relay to the server

```bash
git clone YOUR_RELAY_REPOSITORY_URL mirendil
cd mirendil
cp .env.example .env
nano .env
```

Configure at least:

```env
PUBLIC_URL=http://YOUR_EC2_PUBLIC_IP:3000

DATABASE_URL=YOUR_SUPABASE_TRANSACTION_POOLER_URL
DIRECT_URL=YOUR_SUPABASE_SESSION_POOLER_URL
SUPABASE_URL=YOUR_SUPABASE_PROJECT_URL
SUPABASE_PASSWORD=YOUR_SUPABASE_DATABASE_PASSWORD

MASTER_KEY=GENERATE_A_RANDOM_KEY

GITHUB_CLIENT_ID=YOUR_GITHUB_OAUTH_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_OAUTH_CLIENT_SECRET

WORKER_REPLICAS=3
```

Generate the encryption key:

```bash
openssl rand -hex 32
```

Users add their own OpenAI API keys from Relay's Home page. Do not add user keys to `.env`.

## 4. Configure GitHub OAuth

Create or update the GitHub OAuth App:

```text
Homepage URL:
http://YOUR_EC2_PUBLIC_IP:3000

Authorization callback URL:
http://YOUR_EC2_PUBLIC_IP:3000/api/connections/github/callback
```

Use the HTTPS domain values from the production section once a domain is available.

## 5. Build and start Relay

```bash
mkdir -p .relay/workspaces

docker build --no-cache \
  -f Dockerfile.agent \
  -t relay-agent:latest .

docker-compose up -d --build --remove-orphans
```

Verify Codex and the services:

```bash
docker run --rm --entrypoint codex relay-agent:latest --version
docker-compose ps
docker-compose logs --tail=100 migrate
docker-compose logs --tail=100 web
docker-compose logs --tail=100 worker
```

The migration service should exit successfully. The web service and configured worker replicas should remain running.

## 6. Allow access through AWS

In AWS:

1. Open **EC2 → Instances**.
2. Select the Relay instance.
3. Open **Security** and select its security group.
4. Choose **Edit inbound rules**.
5. Add a temporary rule:

```text
Type: Custom TCP
Port: 3000
Source: My IP
```

Use `0.0.0.0/0` only for temporary public testing.

If UFW is enabled on Ubuntu:

```bash
sudo ufw allow 3000/tcp
```

Confirm the server is listening:

```bash
curl http://localhost:3000/health
sudo ss -lntp | grep 3000
```

Expected health response:

```json
{"ok":true}
```

Visit:

```text
http://YOUR_EC2_PUBLIC_IP:3000
```

## 7. Production domain and HTTPS

Point the domain's DNS A record to the EC2 public IP. Install Nginx and Certbot on Ubuntu:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Configure Nginx to proxy the domain to `http://127.0.0.1:3000`, then issue a certificate:

```bash
sudo certbot --nginx -d relay.example.com
```

Update `.env`:

```env
PUBLIC_URL=https://relay.example.com
```

Update the GitHub OAuth App:

```text
Homepage URL:
https://relay.example.com

Authorization callback URL:
https://relay.example.com/api/connections/github/callback
```

Restart the web service:

```bash
docker-compose up -d --force-recreate web
```

Allow inbound ports 80 and 443 in the EC2 security group, then remove public access to port 3000.

## 8. Operations

Follow logs:

```bash
docker-compose logs -f web worker
```

Deploy new code:

```bash
git pull
docker build --no-cache -f Dockerfile.agent -t relay-agent:latest .
docker-compose up -d --build --remove-orphans
```

Change worker concurrency in `.env`:

```env
WORKER_REPLICAS=3
```

Then apply it:

```bash
docker-compose up -d worker
```

Stop Relay without deleting Supabase data:

```bash
docker-compose down
```
