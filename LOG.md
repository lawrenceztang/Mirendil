# Decision log

Brief, chronological, append-only. Records only important user-driven product and architecture decisions.

## 2026-07-17

1. **User requested a production-minded cloud agent chat app.** Chose durable sessions, resumable work, repository workspaces, persistent artifacts, and visible run results.

2. **User chose Node.js with TypeScript for the backend.** Built the API, worker, persistence, and shared domain logic in strict TypeScript.

3. **User chose one isolated Docker container per agent run.** Kept the trusted orchestrator separate from constrained, non-root task containers.

4. **User requested real OpenAI execution.** Enabled model-authored repository changes while retaining a keyless demo path.

5. **User requested pull request delivery.** Added run branches, commits, pushes, draft PR creation, and PR links in results.

6. **User decided service connections must be controlled by the user.** Scoped GitHub connections per workspace, encrypted tokens at rest, and kept credentials outside agent containers and Git configuration.

7. **User requested a continuing decision log.** This file stays brief, chronological, user-focused, and limited to material decisions.

8. **User chose Supabase instead of local PostgreSQL.** Removed the Compose database service and connected the API, worker, and migrations to Supabase Postgres over TLS.

9. **User chose GitHub login through an integration.** Replaced manual token entry with a per-workspace GitHub OAuth connection and encrypted delegated tokens.

10. **User moved GitHub connection to the home page.** Made GitHub authorization app-level so one connected account serves all sessions.

11. **User simplified workspace creation to chat creation.** Replaced the multi-field setup flow with one-click “New chat” creation and sensible defaults.

12. **User required a repository when creating a chat.** Kept setup minimal with one repository URL and derived all other defaults.

13. **User required GitHub login and private user data.** Made GitHub OAuth the Relay identity and scoped chats, runs, artifacts, repositories, and delegated credentials to that user.

14. **User enabled more concurrent workers.** Set the default deployment to three workers, allowing three independently leased runs at once.

15. **User required a Codex agent in every worker.** Replaced the custom one-shot editor with isolated, non-interactive Codex CLI agents that can inspect, edit, and verify each repository task.

16. **User required users to supply their own OpenAI key.** Removed the shared server key and encrypted each user's key for use only by that user's Codex runs.

17. **User chose direct pull-request delivery.** Removed generated diff/patch artifacts; Relay now commits Codex's workspace changes and opens the PR directly.

18. **User required conversational PR continuity.** Made each chat own one PR branch so later prompts commit to and update the existing pull request.

19. **User hosted Relay on AWS EC2.** Deployed the Docker-based web, worker, and per-run Codex container architecture on a cloud VM with Supabase persistence.

20. **User required Codex to modify Git workspaces on Linux.** Made the trusted worker grant each bind-mounted workspace to the non-root Codex UID before execution.

21. **User chose copy-in/copy-out agent isolation.** Codex now edits a private container copy; Relay validates and imports working-tree output while keeping host Git metadata inaccessible.
