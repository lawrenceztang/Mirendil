# Run Relay on AWS EC2

This guide installs Relay on one Ubuntu EC2 instance. The web app and three workers run with Docker Compose, temporary Codex containers run through the instance's Docker daemon, and durable application data stays in Supabase.

## 1. Launch the EC2 instance

In **AWS Console → EC2 → Instances → Launch instance**, use:

```text
Name: Relay
AMI: Ubuntu Server 24.04 LTS, 64-bit x86
Instance: 4 vCPU and at least 8 GiB RAM (for example, c6i.xlarge)
Key pair: Create or select an SSH key pair
Root volume: 50 GiB gp3
Auto-assign public IP: Enabled
```

Create or select a security group with both rules below:

```text
SSH          TCP 22    Source: My IP
Custom TCP   TCP 3000  Source: My IP
```

Keep the SSH rule when adding port `3000`. Choose `Anywhere-IPv4` for port `3000` only when Relay intentionally needs to be publicly reachable.

After launching, allocate a stable address from **EC2 → Elastic IP addresses**, then associate it with the instance. Use that address as `YOUR_EC2_IP` throughout this guide.

On your Mac, connect with the downloaded key:

```bash
chmod 400 ~/Downloads/relay.pem
ssh -i ~/Downloads/relay.pem ubuntu@YOUR_EC2_IP
```

## 2. Install Git and Docker

Run these commands on the EC2 instance. They install Docker Engine and Compose V2 from Docker's official Ubuntu repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git nano openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Disconnect and reconnect so the Docker group change takes effect:

```bash
exit
ssh -i ~/Downloads/relay.pem ubuntu@YOUR_EC2_IP
```

Verify the installation:

```bash
git --version
docker --version
docker compose version
docker run --rm hello-world
```

This guide consistently uses the Compose V2 command `docker compose`.

## 3. Create a GitHub OAuth App

1. Open [https://github.com/settings/developers](https://github.com/settings/developers).
2. Select **OAuth Apps → New OAuth App**.
3. Enter:

```text
Application name: Relay AWS
Homepage URL: http://YOUR_EC2_IP:3000
Authorization callback URL: http://YOUR_EC2_IP:3000/api/connections/github/callback
```

4. Select **Register application**.
5. Generate a client secret.
6. Save the client ID and client secret.

The callback URL must exactly match Relay's `PUBLIC_URL`. The Elastic IP prevents it from changing when the EC2 instance restarts.

## 4. Create the Supabase database

1. Open [https://supabase.com/dashboard](https://supabase.com/dashboard) and select **New project**.
2. Choose a project name, region, and database password.
3. Wait for the project to finish provisioning.
4. Select **Connect → Session pooler**.
5. Copy the complete PostgreSQL URL using port `5432`.
6. Replace `[YOUR-PASSWORD]` with the URL-encoded project database password.
7. Save the completed URL.

Copy the entire Session pooler URL from one project. Do not combine a project reference, username, or pooler host from different connection strings.

## 5. Create an OpenAI API key

1. Configure API billing at [https://platform.openai.com/settings/organization/billing](https://platform.openai.com/settings/organization/billing).
2. Open [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. Select **Create new secret key** and save it.

Each Relay user enters their own key after signing in. Do not put an OpenAI key in the server `.env` file.

## 6. Clone and configure Relay

Run on the EC2 instance:

```bash
git clone https://github.com/lawrenceztang/Mirendil
cd Mirendil
cp .env.example .env
openssl rand -hex 32
nano .env
```

Put the generated master key and saved credentials into `.env`:

```env
PUBLIC_URL=http://YOUR_EC2_IP:3000
SUPABASE_DATABASE_URL=YOUR_COMPLETE_SESSION_POOLER_URL
MASTER_KEY=OUTPUT_FROM_OPENSSL
GITHUB_CLIENT_ID=YOUR_OAUTH_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_OAUTH_CLIENT_SECRET
```

Keep `MASTER_KEY` unchanged across redeployments. Relay needs the same key to decrypt stored GitHub and OpenAI credentials.

## 7. Build the Codex agent

```bash
cd ~/Mirendil
mkdir -p .relay/workspaces
docker build -f Dockerfile.agent -t relay-agent:latest .
docker run --rm --entrypoint codex relay-agent:latest --version
```

## 8. Create the Supabase schema

Run Relay's ordered migrations:

```bash
docker compose run --rm --build migrate
```

The first run prints `Applied 001_initial.sql` followed by the remaining migration names. Later runs are safe and do not reapply completed migrations.

If migration fails, display the actual database error with:

```bash
docker compose run --rm migrate
```

An error containing `tenant/user ... not found` means the Supabase project reference and pooler host in `.env` do not belong to the same Session pooler URL.

## 9. Start Relay

```bash
docker compose up -d --build web worker
docker compose ps
docker compose logs --tail=100 web worker
curl http://localhost:3000/health
```

The web container and three worker containers should show `Up`, and the health request should return:

```json
{"ok":true}
```

Open Relay at:

```text
http://YOUR_EC2_IP:3000
```

## 10. Run a task

1. Sign in with GitHub.
2. Enter the OpenAI API key from step 5.
3. Select a GitHub repository that the signed-in account can push to. Relay needs write access to create branches and pull requests.
4. Start a chat with:

```text
Add a concise CONTRIBUTING.md for first-time contributors.
```

## Redeploy Relay

Run this after pulling application or agent-runtime changes. Docker reuses unchanged build layers, so `--no-cache` is unnecessary:

```bash
cd ~/Mirendil
git pull --ff-only
docker build -f Dockerfile.agent -t relay-agent:latest .
docker compose run --rm --build migrate
docker compose up -d --build --force-recreate web worker
docker compose ps
docker compose logs --tail=100 web worker
```

## Add a production domain and HTTPS

Do not send OpenAI keys over public plain HTTP. For use beyond a short restricted test, point a domain's DNS `A` record at the Elastic IP and terminate HTTPS before Relay.

Install Nginx and Certbot:

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

Update the GitHub OAuth App to exactly match:

```text
Homepage URL: https://relay.example.com
Authorization callback URL: https://relay.example.com/api/connections/github/callback
```

Allow inbound TCP ports `80` and `443` in the EC2 security group, remove public access to port `3000`, and recreate the web service:

```bash
docker compose up -d --force-recreate web
```

## Recover from a full EC2 disk

Check disk space, inode use, and Docker storage:

```bash
df -h /
df -i /
docker system df
```

Remove stopped containers, unused images, networks, and build cache:

```bash
docker system prune -af
sudo journalctl --vacuum-size=200M
```

Do not run `docker volume prune` or add `--volumes`. Relay stores persistent Codex conversation history in `relay-codex-*` Docker volumes.

If the root EBS volume needs more space, take a snapshot and increase it from **EC2 → Volumes → Modify volume**. After AWS reports the modification as `optimizing` or `completed`, inspect the device:

```bash
lsblk
df -hT /
```

For a typical Nitro Ubuntu instance using Ext4:

```bash
sudo growpart /dev/nvme0n1 1
sudo resize2fs /dev/nvme0n1p1
```

For a Xen device, use `/dev/xvda 1` and `/dev/xvda1`. If `df -hT /` reports XFS, use:

```bash
sudo xfs_growfs -d /
```

Verify the expanded capacity:

```bash
lsblk
df -hT /
```

See the [AWS EBS filesystem expansion guide](https://docs.aws.amazon.com/ebs/latest/userguide/recognize-expanded-volume-linux.html) for device-specific instructions.
