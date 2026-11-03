import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "hermes-run");

export interface HermesReply {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export type HermesBackend = "host" | "docker";

/** Which backend would bin/hermes-run pick? Mirrors its docker-first auto-detection. */
export function detectBackend(): HermesBackend | null {
  const preferred = process.env.HERMES_BACKEND?.trim();
  if (preferred === "host" || preferred === "docker") return preferred;
  const has = (cmd: string): boolean =>
    spawnSync("bash", ["-c", `command -v ${cmd} >/dev/null 2>&1`]).status === 0;
  if (has("docker")) return "docker";
  if (has("hermes")) return "host";
  return null;
}

export const hermesAvailable = (): boolean => detectBackend() !== null;

/**
 * Drive the real Hermes agent headlessly via bin/hermes-run
 * (`hermes chat --oneshot` on the host, or the official
 * nousresearch/hermes-agent Docker image with the profile mounted at
 * /opt/data). Hermes runs with HERMES_HOME=profile/ in both cases, so it
 * sees the NEAR AI Cloud model and the agent_api MCP tools only.
 */
export async function queryHermes(prompt: string, timeoutMs = 300_000): Promise<HermesReply> {
  if (!existsSync(bin)) throw new Error(`Missing ${bin}`);
  if (!existsSync(path.join(root, "profile", ".env"))) {
    throw new Error("Not provisioned yet. Run:  npm run provision");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [bin, prompt], { cwd: root, env: process.env });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`Hermes timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code, output: output.trim() });
      }
    });
  });
}

export function requireProvisioned(): void {
  if (!existsSync(path.join(root, "profile", ".env"))) {
    console.error("Not provisioned yet. Run:  npm run provision");
    process.exit(1);
  }
}
