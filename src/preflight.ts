// Check the model backend before launching a browser, so a signed-out Claude
// Code or a missing API key fails in a second with a next step, not after the
// app has been opened and the first model call made.
import { execFile } from "node:child_process";
import { MODEL, client } from "./claude.js";
import type { Backend } from "./driver.js";

const checked = new Map<Backend, Promise<void>>();

/** Throws a readable error if the backend can't run. Checked once per process. */
export function checkBackend(backend: Backend): Promise<void> {
  if (process.env.WITNESS_SKIP_PREFLIGHT === "1") return Promise.resolve();
  let p = checked.get(backend);
  if (!p) {
    p = backend === "api" ? checkApi() : checkClaudeCode();
    checked.set(backend, p);
    p.catch(() => checked.delete(backend)); // let a later call retry after a fix
  }
  return p;
}

function checkClaudeCode(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["auth", "status"], { timeout: 20_000, shell: process.platform === "win32" }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(
          new Error(`Claude Code ("claude") isn't installed or isn't on PATH. Install it, or use --backend api with ANTHROPIC_API_KEY.`),
        );
      }
      let status: { loggedIn?: boolean } | undefined;
      try {
        status = JSON.parse(stdout);
      } catch {
        // An older Claude Code without `auth status`: don't block, the run will tell.
        return resolve();
      }
      if (status?.loggedIn === false) {
        return reject(
          new Error("Claude Code isn't signed in. Run `claude` and sign in with /login, or use --backend api with ANTHROPIC_API_KEY."),
        );
      }
      resolve();
    });
  });
}

async function checkApi(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("--backend api needs ANTHROPIC_API_KEY. Set it, or use --backend claude-code with your Claude Code sign-in.");
  }
  try {
    await client.models.retrieve(MODEL);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw new Error("The Claude API rejected ANTHROPIC_API_KEY. Check the key.");
    if (status === 404) throw new Error(`The Claude API has no model "${MODEL}". Check WITNESS_MODEL.`);
    throw new Error(`Couldn't reach the Claude API: ${err instanceof Error ? err.message : err}`);
  }
}
