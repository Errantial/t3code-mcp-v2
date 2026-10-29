#!/usr/bin/env node
// Source-only handoff. Explicit allowlist prevents credential/runtime leakage.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const name = `t3code-mcp-v2-${version}.tar.gz`;
const output = join(root, "artifacts");
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), "t3-mcp-handoff-"));
const folder = join(staging, "t3code-mcp-v2");
mkdirSync(folder);
const entries = ["src", "scripts", "tests", "deploy", "package.json", "pnpm-lock.yaml", "tsconfig.json", ".gitignore", ".env.example", "README.md", "AGENT_SETUP.md", "AGENT_PROMPT.md", "COMPATIBILITY_PLAN.md", "SPEC.md", "PLAN.md"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function files(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in handoff: ${entry.name}`);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(directory, entry.name), relative) : [relative];
  });
}
try {
  for (const entry of entries) cpSync(join(root, entry), join(folder, entry), { recursive: true, dereference: false });
  const paths = files(folder).sort();
  const secrets = (existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "").split("\n").filter(line => /^(T3_TOKEN|MCP_HTTP_TOKEN)=/.test(line)).map(line => line.slice(line.indexOf("=") + 1)).filter(Boolean);
  for (const path of paths) {
    const data = readFileSync(join(folder, path));
    for (const secret of secrets) if (data.includes(Buffer.from(secret))) throw new Error(`Credential detected in ${path}`);
  }
  writeFileSync(join(folder, "SOURCE_MANIFEST.json"), JSON.stringify({ version, protocol: 2, files: Object.fromEntries(paths.map(path => [path, sha256(readFileSync(join(folder, path)))])) }, null, 2) + "\n");
  execFileSync("tar", ["-czf", join(output, name), "-C", staging, "t3code-mcp-v2"]);
  writeFileSync(join(output, `${name}.sha256`), `${sha256(readFileSync(join(output, name)))}  ${name}\n`);
  cpSync(join(root, "AGENT_SETUP.md"), join(output, "AGENT_SETUP.md"));
  console.log(`Created artifacts/${name}, checksum and AGENT_SETUP.md (${paths.length} source files; no host credentials).`);
} finally { rmSync(staging, { recursive: true, force: true }); }
