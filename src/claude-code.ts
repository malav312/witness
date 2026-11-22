// Runs headless Claude Code (`claude -p`) as a model backend. It uses whatever
// the local Claude Code CLI is signed in with, e.g. a Claude subscription,
// so no API key is needed.
import { spawn } from "node:child_process";

export interface ClaudeCodeRun {
  prompt: string;
  systemPrompt: string;
  /** Built-in Claude Code tools to enable ("" = none). */
  tools: string;
  allowedTools: string[];
  mcpUrl?: string;
  jsonSchema?: object;
  cwd?: string;
  addDirs?: string[];
  timeoutMs?: number;
}

export interface ClaudeCodeResult {
  text: string;
  structured: unknown;
  inputTokens: number;
  outputTokens: number;
  hitTurnLimit: boolean;
}

export async function runClaudeCode(run: ClaudeCodeRun): Promise<ClaudeCodeResult> {
  const args = [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    // Isolate from the user's own settings, hooks, plugins and MCP servers.
    "--setting-sources", "",
    "--strict-mcp-config",
    "--system-prompt", run.systemPrompt,
    "--tools", run.tools,
    "--allowedTools", ...run.allowedTools,
    "--permission-mode", "dontAsk",
  ];
  if (process.env.WITNESS_MODEL) args.push("--model", process.env.WITNESS_MODEL);
  if (run.mcpUrl) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: { witness: { type: "http", url: run.mcpUrl } } }));
  }
  if (run.jsonSchema) args.push("--json-schema", JSON.stringify(run.jsonSchema));
  for (const dir of run.addDirs ?? []) args.push("--add-dir", dir);

  const env = { ...process.env };
  // Make sure Claude Code uses its own sign-in, not an API key from this shell.
  delete env.ANTHROPIC_API_KEY;

  const child = spawn("claude", args, { cwd: run.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(run.prompt); // prompt via stdin: action logs can be long

  const timeout = setTimeout(() => child.kill("SIGTERM"), run.timeoutMs ?? 15 * 60_000);
  const code: number | null = await new Promise((resolve, reject) => {
    child.on("error", (err) =>
      reject(new Error(`Could not start Claude Code ("claude"). Is it installed and signed in? ${err.message}`)),
    );
    child.on("close", resolve);
  });
  clearTimeout(timeout);

  let out: any;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code exited ${code} without a JSON result. ${stderr.trim().slice(0, 500)}`);
  }
  if (out.is_error && !out.structured_output) {
    throw new Error(`Claude Code error (${out.subtype}): ${String(out.result ?? stderr).slice(0, 500)}`);
  }
  const usage = out.usage ?? {};
  return {
    text: String(out.result ?? ""),
    structured: out.structured_output,
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    hitTurnLimit: out.subtype === "error_max_turns",
  };
}
