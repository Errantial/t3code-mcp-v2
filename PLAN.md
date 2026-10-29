> Historical v1 design/build notes. The current implementation targets protocol v2; see README.md and COMPATIBILITY_PLAN.md.

# Implementation Plan

See SPEC.md for the full tool surface and architecture. Stack: Node 22+, TypeScript (ES modules), `@modelcontextprotocol/sdk`, `zod`. No dependency on the t3code monorepo.

## Layout

```
src/
  index.ts      entry: CLI flags, transport selection (stdio default, --http in P3)
  config.ts     origin discovery (server-runtime.json / T3_ORIGIN), token loading (T3_TOKEN / .env)
  client.ts     T3 HTTP client: probe, shell, threadDetail, dispatch; error mapping
  model.ts      wire types + derivation helpers (attention state, pending requests from activities)
  format.ts     compact/voice-friendly output shaping, truncation
  tools/
    phase1.ts   t3_status, list_projects, list_threads, get_thread, send_message
    phase2.ts   pending_actions, respond_to_approval, respond_to_user_input, create_thread,
                interrupt_thread, stop_thread, wait_for_turn, archive/unarchive, set_thread_title
    phase3.ts   thread_digest, workspace_digest, search_threads, wait_for_change
  http.ts       (P3) streamable HTTP transport with bearer auth
scripts/
  smoke.mjs     drives the built server over stdio JSON-RPC against the live T3 instance
```

## Phase 1 — Core visibility & messaging  ✅ must ship first

1. Scaffold: `package.json` (bin: `t3code-mcp`), `tsconfig.json`, `.gitignore`, `.env.example`.
2. `config.ts`: read `~/.t3/userdata/server-runtime.json`; probe `/.well-known/t3/environment`; load token from `T3_TOKEN` or `.env` next to the package.
3. `client.ts` + `model.ts`: shell snapshot, thread detail, dispatch; derive `attention` per thread; extract open approvals/questions by folding `approval.requested/resolved` + `user-input.requested/resolved` activities.
4. Tools: `t3_status`, `list_projects`, `list_threads`, `get_thread`, `send_message`.
5. Verify live: list real projects/threads, read a thread, send a message to a disposable test thread.

**Exit criteria:** from Claude Code, `claude mcp add` the server and successfully list threads, read one, and send a message that starts a real turn.

## Phase 2 — Control & interaction

1. `pending_actions` (cross-thread inbox) — built on shell snapshot flags + per-thread detail for request payloads.
2. Approval/user-input responders; `interrupt_thread`, `stop_thread`.
3. `create_thread` via `thread.turn.start` + `bootstrap.createThread` (model from project default; optional worktree via `prepareWorktree`).
4. `wait_for_turn` polling loop (poll thread detail at ~1.5s; stop on turn completion, approval/input request, error, or timeout).
5. Housekeeping: archive/unarchive, `set_thread_title`.
6. Live-verify the full loop on a disposable thread: create → wait → respond → interrupt → archive.

**Exit criteria:** a full hands-free session on one thread — create it, get asked something, answer, get the result, archive — without touching the T3 UI.

## Phase 3 — Voice & remote layer

1. `format.ts` digest builders (strip markdown/code for TTS; summarize tool activity counts; relative times).
2. `thread_digest`, `workspace_digest`, `search_threads`, `wait_for_change`.
3. `--http` mode: streamable HTTP transport, `MCP_HTTP_TOKEN` bearer check, loopback bind by default.
4. Docs: connecting a remote voice client (Hermes) over Tailscale.

**Exit criteria:** an MCP client connecting over HTTP with a token can ask "what needs me?" and get a speakable answer.

## Testing strategy

- Primary: `scripts/smoke.mjs` — spawns the built server over stdio, calls each tool via raw JSON-RPC, asserts on live responses from the running T3 instance.
- Mutation tests target a **disposable thread** in a scratch project only; never dispatch to real work threads.
- No mocked-server unit suite for now — the contract is T3's API and the live instance is always available on this machine.

## Risks / notes

- T3 nightly moves fast; wire shapes are mirrored loosely (unknown fields ignored, parse defensively). `t3_status` includes the server version so drift is diagnosable.
- `orchestration.searchThreads` and diffs are WS-RPC-only; deferred (client-side search suffices).
- Token is minted once with 365d TTL; revocable via `npx t3 auth session list/revoke`.
