# Copy this prompt to the agent on the destination machine

Install and verify t3code-mcp 0.4.0 with T3 orchestration protocol v2 support on
this machine. Fetch the actual implementation remotely from this public GitHub
repository:

https://github.com/Errantial/t3code-mcp-v2

First read and follow the complete setup guide:

https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/AGENT_SETUP.md

Download this exact package and checksum with `curl --fail --location`:

https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz

https://raw.githubusercontent.com/Errantial/t3code-mcp-v2/main/downloads/t3code-mcp-v2-0.4.0.tar.gz.sha256

Verify the checksum before extracting. The original ThomasCrund/t3code-mcp
repository is upstream; cloning it alone will not install this v2 port.

Inspect this machine's OS, running T3 instance, installed T3 CLI and Node version.
Build the supplied code and run its regression tests. Use this machine's T3 user
and CLI to mint fresh scoped credentials using `scripts/configure.mjs`; never
copy another machine's tokens or expose them in chat. Preserve credentials if
this is an upgrade. Configure persistent operation and HTTPS using the supplied
templates and the destination's actual DNS/network setup. Preserve existing
services. Ask for destination-specific information only if local inspection
cannot resolve it.

Run `scripts/verify.mjs` against localhost and the actual remote endpoint. Test
real writes with `scripts/integration.mjs` only in a dedicated scratch project
with a working provider/model; follow the guide's provider requirements. Do not
claim success from tool discovery alone. Report any missing prerequisite or
failed flow accurately, and do not invent a working public URL.

Finish by reporting the installed bridge/T3 versions, service name, verified
remote URL, Streamable HTTP transport, bearer authentication method, protected
client-config path, and test results. Provide the ready-to-use client config
privately; never paste the credential itself into the report.
