import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerRuntime } from "./model.js";

const RUNTIME_PATH = join(homedir(), ".t3", "userdata", "server-runtime.json");

export class ConfigError extends Error {}

/** Parse a minimal KEY=VALUE .env file (no quoting rules needed here). */
function parseDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

function dotEnvCandidates(): string[] {
  const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url))); // dist/.. = package root
  return [join(process.cwd(), ".env"), join(pkgRoot, ".env")];
}

export function discoverOrigin(): string {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN.replace(/\/$/, "");
  if (!existsSync(RUNTIME_PATH)) {
    throw new ConfigError(
      `T3 Code doesn't appear to be running: ${RUNTIME_PATH} not found. ` +
        `Start the T3 Code desktop app or run \`npx t3@latest\`, or set T3_ORIGIN.`,
    );
  }
  try {
    const runtime = JSON.parse(readFileSync(RUNTIME_PATH, "utf8")) as ServerRuntime;
    if (!runtime.origin) throw new Error("no origin field");
    return runtime.origin.replace(/\/$/, "");
  } catch (e) {
    throw new ConfigError(`Could not read T3 server runtime file (${RUNTIME_PATH}): ${e}`);
  }
}

export function loadToken(): string {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
  for (const path of dotEnvCandidates()) {
    if (existsSync(path)) {
      const env = parseDotEnv(path);
      if (env.T3_TOKEN) return env.T3_TOKEN;
    }
  }
  throw new ConfigError(
    "No T3 auth token found. Mint one with " +
      "`npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d` " +
      "and set it as T3_TOKEN (env var, or .env next to t3code-mcp).",
  );
}

export function loadHttpToken(): string | undefined {
  if (process.env.MCP_HTTP_TOKEN) return process.env.MCP_HTTP_TOKEN;
  for (const path of dotEnvCandidates()) {
    if (existsSync(path)) {
      const env = parseDotEnv(path);
      if (env.MCP_HTTP_TOKEN) return env.MCP_HTTP_TOKEN;
    }
  }
  return undefined;
}
