# Agent handoff: install t3code-mcp with T3 protocol v2

## Task and authoritative source

Install this **t3code-mcp 0.4.0 v2 port** on the destination machine and verify it
against that machine's running T3 Code instance. Preserve any existing services.
Report the actual working endpoint, transport, credential-file location and
verification results when finished.

**Fetch this v2 port from https://github.com/Errantial/t3code-mcp-v2.**
The original `ThomasCrund/t3code-mcp` repository is the upstream project, not the
source of this v2 package. Do not substitute an upstream clone for this port.

Direct package downloads (no GitHub login required for the public repository):

- Archive: https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz
- Checksum: https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz.sha256
- Agent prompt: https://github.com/Errantial/t3code-mcp-v2/blob/main/AGENT_PROMPT.md

The archive includes the complete source, lockfile, tests and deployment templates.
It deliberately contains no `.env`, client credentials, machine-specific service
config, node_modules, rollback build or T3 session data.

The current reference installation is tested against T3 Code
`0.1.3-v1.1.1.20261026.22512a5.linux1`. It uses HTTP reads with
`x-t3-orchestration-protocol: 2` and authenticated Effect WebSocket RPC on
`/ws?orchestrationProtocol=2&wsTicket=...`. The MCP client's transport is
**Streamable HTTP**, not the internal T3 WebSocket protocol.

## 1. Inspect the destination

- Identify the OS, install directory, running T3 instance and its OS user.
- Run the bridge as that same user. Use Node.js **24 LTS** (reference version
  24.21.0; package minimum is Node 22) and pnpm (reference version 12.16.1).
- T3 must already be installed, running and authenticated to at least one agent
  provider. This bridge neither installs T3 nor signs in to provider accounts.
- Locate the installed T3 CLI: `command -v t3`, or `~/.t3/bin/t3` on the reference
  Linux installation. Use the CLI shipped with the running T3 installation;
  do not download a different T3 version merely to mint a token.
- Inspect `t3 auth session issue --help` and confirm support for `--token-only`,
  `--ttl`, and `--scope`. If unavailable, report the actual mismatch.
- For remote access choose a domain and HTTPS proxy, or an existing private TLS
  endpoint. Do not reuse the reference machine's domain/IP or credentials.

For default local T3 discovery, this bridge reads
`~/.t3/userdata/server-runtime.json`. For a different data directory or explicit
server location, export `T3_ORIGIN` in the bridge process/service environment.
**This version does not load `T3_ORIGIN` from `.env`.** The token must belong to
the selected instance. Do not copy the reference machine's runtime file.

## 2. Transfer and build the supplied port

Download the archive and its `.sha256` file, then verify and extract them into a
stable location owned by the T3 user. Avoid temporary directories for the real
installation. The following commands assume a Unix-like shell:

```bash
# Download the exact v2 package from the dedicated GitHub repository.
curl --fail --location --output t3code-mcp-v2-0.4.0.tar.gz \
  https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz
curl --fail --location --output t3code-mcp-v2-0.4.0.tar.gz.sha256 \
  https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz.sha256
sha256sum -c t3code-mcp-v2-0.4.0.tar.gz.sha256
# macOS alternative: shasum -a 256 -c t3code-mcp-v2-0.4.0.tar.gz.sha256
mkdir -p "$HOME/apps"
tar -xzf t3code-mcp-v2-0.4.0.tar.gz -C "$HOME/apps"
cd "$HOME/apps/t3code-mcp-v2"
node --version
pnpm install --frozen-lockfile
pnpm test
```

If pnpm is unavailable, use `npx --yes pnpm@12.16.1` in place of `pnpm`.
The `test` script runs `tsc && node --test tests/*.test.mjs`; if invoking via
npx, run `npx --yes pnpm@12.16.1 build` followed by
`node --test tests/*.test.mjs` as separate commands instead. Confirm
`package.json` version is `0.5.1` and
`src/rpc.ts` and `src/v2.ts` exist. The source must compile and all regression
tests must pass before deployment. Do not claim v2 support just because MCP
initialization or tool listing succeeds.

## 3. Generate fresh credentials on this machine

Run from the installation directory as the same OS user as T3:

```bash
node scripts/configure.mjs \
  --t3-cli /absolute/path/to/installed/t3 \
  --url https://YOUR-MCP-DOMAIN/
```

For a local-only installation, omit `--url`; the default client URL is
`http://127.0.0.1:3774/`.

The script calls the installed CLI to issue a 365-day T3 access token with only
`orchestration:read` and `orchestration:operate`, generates a separate random MCP
HTTP token, and creates `.env` and `remote-client.json` with mode 0600. It never
prints the credentials and refuses to overwrite existing credential files.

These are two different credentials:

- `T3_TOKEN`: bridge → local T3 API. Keep this on the server.
- `MCP_HTTP_TOKEN`: remote client → bridge. The generated `remote-client.json`
  includes it in the `Authorization: Bearer ...` header.

For an upgrade, keep existing credential files and skip this script. If the URL
changes, edit only the URL in `remote-client.json`; do not unnecessarily rotate
working tokens. If an existing token expires or lacks scopes, replace it using
the destination's installed CLI. Do not paste credentials into an agent chat,
logs, a public repository or the completion report.

## 4. Verify T3 reads, then run the bridge

```bash
pnpm smoke
node dist/index.js --http --host 127.0.0.1 --port 3774
```

Run the second command in a persistent terminal for the initial check. From a
second terminal in the same installation directory:

```bash
node scripts/verify.mjs http://127.0.0.1:3774/
```

The verifier checks invalid/missing credentials return 401, discovers exactly
20 tools, and makes actual T3 read calls. It requires `t3_status` fields
`running`, `authOk`, `readCompatible`, `commandChannelReady`, and `canOperate`
to all be true, with orchestration protocol 2. It prints version/readiness data
without printing tokens or conversation contents.

If `pnpm smoke` fails because the destination has no threads, use the read-only
verifier for initial readiness; the legacy smoke script assumes existing
projects/threads. A provider-backed scratch integration test remains necessary
to validate writes.

## 5. Make the process persistent

Linux/systemd reference workflow:

1. Stop the temporary foreground bridge so port 3774 is free.
2. Copy `deploy/t3code-mcp.service.template` to
   `~/.config/systemd/user/t3code-mcp.service`.
3. Replace `/ABSOLUTE/INSTALL/PATH` with the extracted installation directory
   and `/ABSOLUTE/NODE/PATH` with the result of `command -v node`.
   Use an absolute, stable Node binary rather than an interactive shell alias.
   If paths contain spaces or `%`, apply proper systemd quoting/escaping.
4. Set `Environment=T3_ORIGIN=...` only if automatic discovery is unsuitable.
5. Run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now t3code-mcp.service
systemctl --user status t3code-mcp.service --no-pager
```

For operation after logout/reboot, enable user lingering if appropriate for this
host: `sudo loginctl enable-linger "$USER"`. T3 itself must also remain running;
starting the bridge does not start T3. Do not run the user service as root or
point it at another user's token/runtime directory.

On macOS, use a LaunchAgent owned by the T3 user with the same absolute Node
command, arguments and working directory; on Windows use that user's task/service
manager. These platform-specific persistence paths were not tested here. The
foreground Node command and MCP protocol are platform independent.

## 6. Configure and verify remote HTTPS

The bridge should listen on `127.0.0.1:3774` behind the existing HTTPS proxy.
Use `deploy/Caddyfile.example` if Caddy is available: replace the example domain,
merge its site block into the existing config, validate, and reload using that
host's normal service workflow. Preserve existing sites and proxy environment
variables. Arrange DNS and ingress for HTTPS on the destination; no change to
T3's own bind address is needed. For another proxy, preserve POST bodies,
Authorization headers and streaming responses; allow up to 360 seconds for long
MCP calls. The proxy terminates TLS and forwards to `127.0.0.1:3774`.

```bash
node scripts/verify.mjs https://YOUR-MCP-DOMAIN/
```

Use the root URL **`https://YOUR-MCP-DOMAIN/`**, not `/mcp` or `/sse`.
The client transport is **Streamable HTTP**, authenticated by the bearer header
in `remote-client.json`. No OAuth configuration is required for this bridge.
For client-specific JSON formats, preserve those URL/transport/header values.

If the existing network cannot expose a domain, keep the service local and
report the missing routing/DNS prerequisite; do not invent a public endpoint.
Local clients can alternatively use stdio:

```json
{
  "mcpServers": {
    "t3code": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/install/path/dist/index.js"]
    }
  }
}
```

The server finds `.env` next to the package even when a stdio client has another
working directory. The stdio connection does not need the MCP HTTP bearer token.

## 7. Verify actual writes in a dedicated scratch project

Create/register a disposable project through the T3 UI or its existing project
API, with its own directory and a working default provider/model. Use Codex for
the supplied integration scenario: it requests the Codex `request_user_input`
and escalated `exec_command` tools to exercise real questions and approvals.
Do not use a user's working project or override provider credentials.

```bash
node scripts/integration.mjs SCRATCH_PROJECT_ID
node scripts/integration.mjs SCRATCH_PROJECT_ID https://YOUR-MCP-DOMAIN/
```

These tests start real agent turns and may incur provider charges. They exercise
all 20 tools, including create/follow-up, exact-run waiting, busy queue,
interruption, session restart/stop, archive/unarchive, rename/search, digests,
questions/answers, stale responses and accepted/declined harmless approvals.
They archive the disposable threads afterward. If the destination uses another
provider, adapt only the test prompts to its actual question/approval tools;
do not report an unexercised flow as passed.

If a test fails, retain its error, inspect only its scratch threads, and archive
any leftover test threads. A command-channel timeout can have an unknown outcome:
inspect thread state before retrying writes to avoid duplicate messages/threads.

## 8. Handoff and upgrades

Report:

- Installed path, bridge version and actual T3 version.
- Service manager/name and whether reboot/logout persistence is configured.
- Verified URL, Streamable HTTP transport, and `Authorization: Bearer` method.
- Protected client config path; transfer this privately to the intended client.
- Build/regression/readiness/integration results, plus any remaining failures.
- T3 access-token lifetime and which service/user owns it; do not report its value.

Keep the archive/checksum and the previous working installation for rollback.
For upgrades, back up the service unit and build, retain credentials, validate
first, then switch/restart and re-run the public verifier. Do not overwrite a
working deployment with upstream protocol-v1 code.

Behavior to communicate: history uses bounded pages and opaque cursors;
`turnLimit` is a legacy hint. Message submission queues behind active work.
Use returned run IDs when waiting for a particular reply. Worktree selection
and image attachments are not exposed by these 20 tools.
