# t3code-mcp

MCP server for a running [T3 Code](https://t3.codes) instance. See which agent threads exist and what they need, read their history, send them messages, approve their permission requests — from Claude Code, Claude Desktop, or (the end goal) a voice-controlled model like Hermes while away from a screen.

**Current version: 0.5.0** — protocol v2, with provider-switch identity fixes,
a cached/incrementally-updated thread index for large workspaces, and lossless
full-message reads (`get_message`).

This version targets **T3 orchestration protocol v2**, tested against T3 Code
`0.1.3-v1.1.1.20261026.22512a5.linux1`. Older protocol-v1 servers are not supported.

Reads use authenticated HTTP with the v2 protocol header; commands use the
server's authenticated WebSocket RPC channel. The remote MCP transport remains
stdio or Streamable HTTP.

## Setup

For installation on another machine, follow [AGENT_SETUP.md](AGENT_SETUP.md).
Fetch this v2 port from https://github.com/Errantial/t3code-mcp-v2.
The current 0.5.0 package is in `downloads/`; start another agent with [AGENT_PROMPT.md](AGENT_PROMPT.md).
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

### Updating an existing install

```bash
git pull
pnpm install
pnpm build
# restart the MCP server / service that runs dist/index.js
```

The package version is in `package.json` (`0.5.0`). For a systemd/Caddy deploy,
rebuild and restart the unit from [deploy/](deploy/) after pulling.

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
- Thread identity is the T3 **app-thread id**. Switching a thread's provider or
  model mid-thread keeps that id, its history and its attention state; only
  `provider`/`model` change. Provider session and provider-thread ids are
  accepted as lookup aliases and are never reported as new threads.
  `wait_for_change` reports a provider switch on the same thread (including
  T3 rotating to a linked provider thread) instead of treating it as new.
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
  delays; the persistent WebSocket also powers the shell index and commands.

### Full-message reads

Conversation reads are capped so one MCP response stays small. Nothing is lost:

- `get_thread` rows are capped at 4000 characters and `wait_for_turn` replies at
  6000. Both accept `maxChars` to change the cap per call, and every row carries
  `messageId`, `totalChars` and a boolean `truncated`.
- `get_message {threadId, messageId, offset, maxChars}` returns one message in
  slices: `{messageId, role, at, totalChars, offset, text, nextOffset, truncated}`.
  `maxChars` defaults to 20000 (ceiling 100000). Pass `nextOffset` back as
  `offset` until it is `null`. Slices carry no ellipsis, so concatenating them
  reproduces the message exactly.
- `get_message` looks a few pages back in history if the id is older than the
  bounded recent window; otherwise it tells you to page back with `get_thread`.
- `T3_MCP_MAX_MESSAGE_CHARS` (e.g. `20000`) overrides the built-in defaults for
  all three; an explicit `maxChars` argument still wins. Values above 100000 are
  clamped, invalid values are ignored.

```text
get_thread  -> messages[].messageId, .truncated, .totalChars
get_message -> text + nextOffset, repeat until nextOffset === null
```


## Large workspaces: cache, defaults and pagination

- A single-thread read (`get_thread`, `thread_digest`, `wait_for_turn`) fetches
  that thread's projection directly. It does **not** download the 600-thread
  shell snapshot.
- Workspace-wide tools share an in-memory thread index. The first call loads one
  shell snapshot; subsequent calls read the index and apply
  `orchestration.subscribeShell` deltas (`thread.updated`, `thread.removed`,
  project updates). Local mutations force a reconcile on the next read.
- `list_threads`, `pending_actions`, `workspace_digest` and `search_threads`
  default to **active or recent, non-archived** threads. Active means
  needs-approval / needs-input / plan-ready / working; recent means updated
  within `sinceHours` (72h for list/search/pending, 24h for workspace digest).
- Old done/idle/error threads are opt-in with `includeInactive: true`; archived
  threads are opt-in with `includeArchived: true` (list/search).
- List/search/workspace/pending tools accept `limit` and return `nextCursor`;
  pass it back as `cursor` for the next page. `search_threads` also returns the
  total `matches`.

Measured against a local 592-thread T3 instance (warm process):

| Call | Before | After |
|---|---:|---:|
| `thread_digest` | 633–810 ms | 50 ms warm (113 ms first) |
| `list_threads` | 392–521 ms | 2 ms warm (344 ms first) |
| `search_threads` | 264–320 ms | 2 ms |
| `workspace_digest` | 248–255 ms | 1–2 ms |

Cold numbers are one shell/projection load; warm numbers use the index or
projection RPC. Actual timings scale with T3's local database size.

## Tools

**Visibility** — `t3_status`, `list_projects`, `list_threads` (filter by project / attention state), `get_thread`, `get_message` (full text of one message in slices), `search_threads`

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
- `node scripts/integration.mjs <scratchProjectId> [httpUrl]` — exercise all 32
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
