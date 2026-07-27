# AGENTS.md — Asset Screener Workspace

The application lives in `screener/`. Before modifying application code, read and obey `screener/AGENTS.md`; it contains the build, deployment, data-safety, and verification requirements.

## Hermes model hierarchy

- The primary brain/orchestrator is `gpt-5.6-sol` with `xhigh` reasoning.
- Delegated leaf executors use `gpt-5.6-luna` with `medium` reasoning through the `openai-codex` provider.
- Keep delegation flat (`max_spawn_depth: 1`) with at most three concurrent children.

## Delegation policy

- The primary agent owns architecture, decomposition, coordination, safety decisions, review, and final verification.
- Delegate bounded implementation, code inspection, testing, and research tasks when parallel work is useful.
- Give each child complete context: exact paths, constraints, acceptance criteria, relevant project rules, and verification commands.
- Treat child summaries as unverified. The primary agent must inspect changed files and run the relevant tests/build before reporting success.
- Do not delegate approval decisions or work that requires user interaction. Preserve all restrictions in `screener/AGENTS.md` when preparing child tasks.
