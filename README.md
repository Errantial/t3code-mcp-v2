# t3code-mcp

MCP server for a running [T3 Code](https://t3.codes) instance. See which agent threads exist and what they need, read their history, send them messages, approve their permission requests — from Claude Code, Claude Desktop, or (the end goal) a voice-controlled model like Hermes while away from a screen.

This version targets **T3 orchestration protocol v2**, tested against T3 Code
`0.1.3-v1.1.1.20261026.22512a5.linux1`. Older protocol-v1 servers are not supported.

Reads use authenticated HTTP with the v2 protocol header; commands use the
server's authenticated WebSocket RPC channel. The remote MCP transport remains
stdio or Streamable HTTP.

## Setup

For installation on another machine, follow [AGENT_SETUP.md](AGENT_SETUP.md).
Fetch this v2 port from https://github.com/Errantial/t3code-mcp-v2.
The package is in `downloads/`; start another agent with [AGENT_PROMPT.md](AGENT_PROMPT.md).
The original ThomasCrund repository is upstream and does not contain this port.

```bash
pnpm install && pnpm build
```

1. Make sure T3 Code is running (desktop app or `npx t3@latest`).
2. Mint a bearer token for the local T3 server and put it in `.env` (or export it):

```bash
npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d
echo "T3_TOKEN=<the token>" > .env
```

3. Sanity check against the live server (read-only):

```bash
pnpm smoke
```

## Connect from Claude Code

```bash
claude mcp add --scope user t3code -- node /Users/thomascrundwell/Documents/projects/t3code-mcp/dist/index.js
```

(Token is picked up from `.env` in this directory; alternatively pass `--env T3_TOKEN=...`.)

## Compatibility and behavior

- `t3_status` reports authentication, v2 read compatibility, command-channel
  readiness and whether the token grants `orchestration:operate` separately.
- `send_message` queues behind active work and returns `messageId` and `runId`.
  Pass that `runId` to `wait_for_turn` to wait for the exact reply. Without it,
  the wait targets the latest run when the call starts.
- `get_thread` returns a server-bounded recent window. Pass `page.beforeCursor`
  back as `beforeCursor` to fetch older history; `page.hasMore` signals more
  pages. `turnLimit` remains an accepted legacy hint, but v2 does not enforce it
  (`page.turnLimitApplied` is false). Responses disclose payload truncation.
- `pending_actions` and `get_thread` return authoritative pending runtime
  requests and their response capabilities. Expired, already answered, wrong-kind
  or non-resumable requests cannot be approved accidentally.
- `stop_thread` detaches live provider sessions belonging to the thread. History
  remains and a new session starts on the next message.
- Connection failures during writes can leave the command outcome unknown.
  Commands are not retried automatically; inspect thread state before retrying.
- Long waits support MCP cancellation. Internally, state is polled with bounded
  delays; a persistent WebSocket is only needed for commands and archive reads.

## Tools

**Visibility** — `t3_status`, `list_projects`, `list_threads` (filter by project / attention state), `get_thread`, `search_threads`

**Messaging & control** — `send_message`, `create_thread`, `wait_for_turn` (send-and-wait round trip), `interrupt_thread`, `stop_thread`, `archive_thread`, `unarchive_thread`, `set_thread_title`

**Hands-free interaction** — `pending_actions` (cross-thread "what needs me?" inbox), `respond_to_approval`, `respond_to_user_input`

**Voice layer** — `thread_digest` and `workspace_digest` (TTS-friendly `spoken` summaries), `wait_for_change` (long-poll until anything needs attention)

Every thread carries a single `attention` state: `needs-approval | needs-input | plan-ready | working | error | done | idle`.

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm test` — build and run protocol/adapter/RPC regression tests.
- `node scripts/integration.mjs <scratchProjectId> [httpUrl]` — exercise all 19
  tools over stdio or Streamable HTTP, including questions, approval acceptance
  and rejection, queueing and interruption. **Use a dedicated scratch project**
  with a configured default provider/model. It starts real agent turns and
  archives its disposable threads afterward. The optional HTTP URL uses
  `MCP_HTTP_TOKEN` from the local `.env` file.

- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- `create_thread` uses T3's launch lifecycle with an explicit root-workspace strategy. It runs in the project checkout; worktree selection is not exposed by this tool.
- Image attachments not yet supported on `send_message`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
