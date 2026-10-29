# T3 protocol v2 compatibility plan

## Goal and scope

Make all 19 existing MCP tools work against installed T3 Code
`0.1.3-v1.1.1.20261026.22512a5.linux1`, through both stdio and the existing
HTTPS Streamable HTTP endpoint. Preserve existing tool names and inputs where
semantics remain valid. Add optional run identifiers where needed. This plan
does not change the running service or implement the port.

The installed bundled server contracts, inspected on 2026-10-29, are the baseline.
The upstream repository's HTTP-only architecture is insufficient for this version.
Target v2 explicitly; retain v1 only as a separate adapter if a real support
requirement emerges. Do not silently fall back to guessed APIs.

## 1. Establish and test the protocol boundary

- Add narrow v2 wire schemas and sanitized fixtures for shell snapshots, bounded
  thread projections, history pages, runs, provider sessions, runtime requests,
  visible turn items, and command responses. Validate required fields and tolerate
  unknown optional fields.
- Make read-only probes against the installed server to confirm endpoint shapes,
  archived-thread retrieval, pagination parameters, WebSocket path and RPC frame
  format. Do not infer the WebSocket envelope from method names.
- Use `x-t3-orchestration-protocol: 2` on orchestration HTTP reads. Classify
  authentication, insufficient scope, unsupported protocol, missing resource,
  transport failure and malformed response separately.
- Extend `t3_status` to distinguish server liveness, authentication, read
  compatibility and command-channel readiness. A protocol failure must not be
  mislabeled as an authentication failure.

## 2. Replace the HTTP-only T3 client

- Keep HTTP for snapshots/history. Add a reusable authenticated WebSocket RPC
  client for commands and archived-shell reads.
- Obtain a short-lived ticket using authenticated POST
  `/api/auth/websocket-ticket`; connect using the installed server's `wsTicket`
  authentication mechanism. Never log tickets, tokens or credential-bearing URLs.
- Support request correlation, timeouts, disconnect cleanup, concurrent calls and
  reconnect with fresh tickets. Scope the upstream client to the MCP process;
  don't open a persistent upstream connection for every stateless HTTP request.
- Send writes through `orchestration.dispatchCommand`; use
  `orchestration.launchThread` for creation and workspace preparation.
- Keep stable command/message IDs across supported retries. Verify server
  deduplication behavior; an interrupted write with unknown outcome must be
  reported/reconciled before retry, rather than blindly duplicated.

## 3. Normalize v2 read models

- Replace assumptions about legacy `session`, `latestTurn` and `activities` with
  explicit view models built from v2 thread shells and projections.
- Combine active and archived shell snapshots for archive-inclusive listing and
  search. Avoid fetching every full thread for ordinary listing.
- Read `projection`, not legacy `thread`. Build conversation output from the
  canonical visible timeline, respecting run association, ordering, streaming
  state and user-visible versus internal items. Do not concatenate raw message
  arrays and timeline arrays, which can duplicate content.
- Use bounded snapshots/history APIs, preserve opaque cursors and expose
  truncation/has-more flags. Do not derive pagination from obsolete `turnLimit`
  query parameters on the full snapshot endpoint.
- Derive actionable approvals/questions from pending `runtimeRequests`, joining
  their display details from related items. Include response capability and
  distinguish expired/cancelled/resolved or non-resumable requests.
- Recompute attention and summaries from v2 run/request/plan state. Cover queued,
  preparing, running, waiting, interrupted, failed, completed and monitoring work;
  preserve the existing seven attention values with explicit mapping rules.

Read tools covered: `t3_status`, `list_projects`, `list_threads`, `get_thread`,
`search_threads`, `pending_actions`, `thread_digest`, `workspace_digest`.

## 4. Port each mutation to current semantics

- `send_message`: replace `thread.turn.start` with `message.dispatch`. Select
  `start_immediately` or `queue_after_active` based on current state and preserve
  queue behavior on races. Apply permission/interaction overrides with the v2
  mode commands; never fall back to `full-access` when state is missing. Return
  message identity and the corresponding run identity when available.
- `create_thread`: use `orchestration.launchThread` with an explicit root workspace
  strategy and initial message, preserving current documented workspace behavior.
  Preserve provider/model options; validate overrides and return preparation
  failures clearly. Worktree creation can be a later additive feature.
- `interrupt_thread`: use `run.interrupt` with the current target run ID. Define
  idle and queued-only results explicitly and avoid interrupting a newer run
  because the original one completed during the request.
- `stop_thread`: audit `thread.stop` versus `provider-session.detach` semantics.
  Preserve the tool's documented session-stop behavior where possible; if v2's
  supported stop also affects queues/delegated work, expose and document that
  behavior explicitly rather than silently widening the operation.
- `archive_thread` / `unarchive_thread`: retain their command types through the
  v2 RPC channel; verify active/archive visibility after completion.
- `set_thread_title`: replace `thread.meta.update` with `thread.metadata.update`.
- `respond_to_approval` / `respond_to_user_input`: use
  `runtime-request.respond`. Validate request kind, pending status, supported
  decision/answer format and response capability before submission. Do not claim
  success for stale or non-resumable requests, or treat missing history as proof
  no approval exists. Approval and user-input decisions remain distinct.

## 5. Make waits reliable

- `wait_for_turn`: add an optional run ID and correlate completion/reply to the
  submitted message/run. Without it, resolve a target once at call start. Do not
  return an older reply based on timestamps or switch targets when a newer run
  starts. Return actionable requests, preparation/provider failures, interruption
  and timeout distinctly.
- `wait_for_change`: compare normalized state including pending-request IDs and
  lifecycle changes. Detect a new question even when attention remains
  `needs-input`, plus archive/unarchive and new-thread changes.
- Start with bounded polling to limit implementation scope. Respect MCP
  cancellation, deadlines and concurrent callers. Add subscriptions only if
  measured latency/load warrants them; do not require a streaming migration to
  finish compatibility.

## 6. Acceptance tests and deployment

- Unit/fixture tests: v2 normalization, all attention states, canonical message
  ordering, history pagination, stale requests and non-resumable requests.
- Transport tests: ticket acquisition, RPC framing/correlation, auth/scope
  failures, disconnect during a write, reconnect, duplicate prevention and
  cancellation. Test stateless HTTP requests sharing the upstream client.
- Read-only integration tests: every read/digest tool against the installed T3
  server, active and archived data, large history and explicit timeouts.
- Mutation tests only in a dedicated scratch project: create, initial reply,
  follow-up, busy-thread queue, rename, interrupt, session stop/restart, archive
  and unarchive. Trigger disposable approval/question scenarios and test both
  accepted/declined approvals and answered questions, plus invalid/stale IDs.
  Use minimal deterministic agent tasks; never use the user's working threads.
- Test all 19 tool contracts over stdio and authenticated HTTPS, including the
  wait tools. Verify unauthenticated/incorrect-token requests still return 401.
- Build a candidate separately from the running dist, complete the tests, then
  restart `t3code-mcp.service`. Verify the public endpoint with real read calls,
  not just initialize/tools-list. Keep the previous build for rollback.
- Update README, smoke scripts, supported-version declaration and SETUP.md with
  actual passing results. Keep endpoint and client bearer credential unchanged.

## Completion gate

All 19 tools pass their applicable contract and integration scenarios against the
installed version. Reads, pagination, requests, queueing and waits have correct
semantics; writes are verified in the scratch project. The HTTPS service passes
post-restart checks, and no known protocol blocker is hidden by a success result.

## Implementation result — 2026-10-29

Implemented and deployed as t3code-mcp 0.3.0. Build, 32 regression tests, and all
19 tools in live stdio/local-HTTP/public-HTTPS integration suites passed.
Approval acceptance/decline and questions/answers were exercised with real agent
requests in a dedicated scratch project. Credentials and endpoint are unchanged.
See README.md for v2 behavior and SETUP.md for deployment and rollback details.
