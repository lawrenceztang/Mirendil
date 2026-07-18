# Report

## Overview

Relay is a cloud-based coding agent.

### Design

Browser (vanilla JS)
          │ HTTP + SSE
          ▼
  Fastify API / Web ─────── GitHub OAuth/API
          │
          ▼
  Supabase PostgreSQL
   sessions, queue, events,
   users, encrypted secrets
          ▲
          │ atomic leasing
     3 worker containers
          │ Docker socket
          ▼
  Ephemeral Codex container
          │
          ├── RW workspace: .relay/workspaces/
          ├── Codex history: relay-codex- volume
          ├── OpenAI API
          └── GitHub commits, pushes, and pull requests

### Request lifecycle

1. The browser sends a prompt to the src/api.ts.
2. The API inserts a queued run into Supabase.
3. One of three src/worker.ts atomically claims it.
4. Relay clones or reuses the chat’s persistent repository workspace.
5. The worker creates one temporary Codex container through Docker.
6. Codex answers the question or edits files, runs checks, commits, pushes, and manages the PR.
7. Relay records the summary, events, branch, and PR URL. The browser receives updates through
SSE.



## Major Decisions (Written by Human)



## Objective

My goal of this project was to create a production-ready cloud coding agent. As in an agent capable enough that you can use it on the go: use your phone to prompt it, and all you have to do is review its pull requests to get code written. I introduced authentication and customizability to ensure the system can meet the demands of multiple users who have different needs.

## Agent Output Format

The agent has two main ways of outputting information: creating pull requests and replying to the user in the chat interface. I decided that the agent would create pull requests because I wanted the agent to be end-to-end: It should be an autonomous developer which requires minimal human intervention, outside of reviewing pull requests. I also realized that software developers ask a lot of questions, so I also enabled the agent to answer questions.

### Connecting Repositories

Signing into Relay requires logging into GitHub. I decided on this because GitHub integration is critical for a coding agent to pull code and create actual pull requests. To simplify the process, the user simply has to log in and doesn't have to connect their GitHub account a second time.

### Concept of a Session

A coding agent is not a normal chatbot. Within a chat, the state of the filesystem can change, and the user should be able to continue where they left off at each new message in the chat. And different chats should not affect each other. Thus, a "session" corresponds to each chat, and each session contains its own copy of a repository.

### Session Persistence

One of the challenges of this project was session persistence. As in, how is the state of the filesystem stored so that the user is able to restore the state when they resume the session? I used Docker containers with Codex running in them to isolate the AI agent. At first I stored the repository state in the main filesystem for long term storage and copied it into the Docker container each time a session was accessed. However, this introduced overhead in copying the session. So I decided on mounting the Docker containers onto a session-specific directory in the main filesystem to allow it to edit this directory directly. Thus when a session is restarted the Codex Docker container mounts onto the session-specific directory to regain the old state of the filesystem.

Persistence is an important aspect because not all changes are immediately pushed through git. We want to be able to edit files and be able to see the edited state of the files later on.

### Queued Requests

I introduced a queue so that when there are multiple requests the ones that cannot be immediately satisfied are lined up in the queue.

### Testing

Towards the middle of this project I was able to use Relay to write itself. I went shopping and prompted it from my phone and found that it was able to satisfy my requests. I discovered numerous bugs, especially involving the filesystem. There were also bugs involving the UI and queued requests. I meticulously addressed all the bugs I encountered so hopefully the end result is relatively bug-free.
