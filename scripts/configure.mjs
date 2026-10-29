#!/usr/bin/env node
// Run as the same OS user as T3. Credentials are written locally, never printed.
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node scripts/configure.mjs [--t3-cli /path/to/t3] [--url https://mcp.example.com/]");
  process.exit(0);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
for (let i = 0; i < args.length; i += 2) {
  if (!["--t3-cli", "--url"].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
}
const url = new URL(option("--url", "http://127.0.0.1:3774/"));
if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("MCP URL must have root path / without credentials, query or fragment");
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS for remote connections");
const envPath = join(root, ".env");
const configPath = join(root, "remote-client.json");
if (existsSync(envPath) || existsSync(configPath)) throw new Error("Existing .env or remote-client.json: refusing to overwrite credentials. Keep them for upgrades.");
const cli = option("--t3-cli", "t3");
const issued = spawnSync(cli, ["auth", "session", "issue", "--token-only", "--label", "t3code-mcp", "--ttl", "365d", "--scope", "orchestration:read", "--scope", "orchestration:operate"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
if (issued.error || issued.status !== 0) throw new Error("T3 token issuance failed. Check the installed T3 CLI, running server, OS user and auth session issue --help. No credentials were printed.");
const token = issued.stdout.trim();
if (!token || /\s/.test(token) || token.length < 20) throw new Error("Unexpected --token-only output; refusing to save it");
const httpToken = randomBytes(32).toString("hex");
process.umask(0o077);
writeFileSync(envPath, `T3_TOKEN=${token}\nMCP_HTTP_TOKEN=${httpToken}\n`, { mode: 0o600, flag: "wx" });
writeFileSync(configPath, JSON.stringify({ mcpServers: { t3code: { type: "http", url: url.href, headers: { Authorization: `Bearer ${httpToken}` } } } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(`Created protected .env and remote-client.json in ${root}. No credentials printed.`);
console.log("T3 access token lifetime: 365 days. Next: pnpm smoke; start HTTP mode; run scripts/verify.mjs.");
