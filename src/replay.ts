// Replay: a passing verification, saved as deterministic steps plus the
// accessibility tree expected after each one. Re-running a replay needs no
// LLM: it's fast and free, and the model is only needed again when the app
// stops matching.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import { BrowserSession, type StepRecord, type Target } from "./browser.js";
import type { RunReport } from "./report.js";

export interface ReplayStep {
  action: "open" | "click" | "type" | "press" | "navigate" | "reload";
  target?: Target;
  text?: string;
  submit?: boolean;
  key?: string;
  /** Path (and query) relative to the app's base URL. */
  path?: string;
  expect: { aria: string; consoleErrors: number };
}

export interface Replay {
  version: 1;
  name: string;
  goal: string;
  recordedAt: string;
  recordedUrl: string;
  fromRun: string;
  steps: ReplayStep[];
}

export const REPLAY_DIR = ".witness/replays";

export function slugify(goal: string): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug.length <= 60) return slug;
  const cut = slug.slice(0, 61);
  return cut.slice(0, cut.lastIndexOf("-")); // end on a whole word
}

const relPath = (url: string, base: string) => {
  const u = new URL(url, base);
  return u.origin === new URL(base).origin ? u.pathname + u.search + u.hash : u.href;
};

const describeTarget = (t?: Target) => (t ? `${t.role}${t.name ? ` "${t.name}"` : ""}` : "element");

/** Turn a passing run into a replay. Returns a reason instead if it can't be replayed. */
export function replayFromRun(report: RunReport): Replay | { error: string } {
  const steps: ReplayStep[] = [];
  for (const s of report.steps as StepRecord[]) {
    if (!s.ok || s.action === "screenshot") continue; // failed attempts and pure looks change nothing
    const expect = { aria: s.aria, consoleErrors: s.consoleErrors.length };
    const input = s.input as Record<string, any>;
    switch (s.action) {
      case "navigate":
        steps.push({ action: steps.length === 0 ? "open" : "navigate", path: relPath(s.url, report.url), expect });
        break;
      case "reload":
        steps.push({ action: "reload", expect });
        break;
      case "press":
        steps.push({ action: "press", key: input.key, expect });
        break;
      case "click":
      case "type":
        if (!s.target) return { error: `step ${s.index} (${s.action}) has no stable target to replay` };
        steps.push(
          s.action === "click"
            ? { action: "click", target: s.target, expect }
            : { action: "type", target: s.target, text: input.text, submit: input.submit, expect },
        );
        break;
    }
  }
  if (steps[0]?.action !== "open") return { error: "run has no starting page" };
  return {
    version: 1,
    name: slugify(report.goal),
    goal: report.goal,
    recordedAt: new Date().toISOString(),
    recordedUrl: report.url,
    fromRun: report.id,
    steps,
  };
}

export async function saveReplay(replay: Replay, dir = REPLAY_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${replay.name}.json`);
  await writeFile(file, JSON.stringify(replay, null, 2) + "\n");
  return file;
}

export async function loadReplays(names: string[], dir = REPLAY_DIR): Promise<{ file: string; replay: Replay }[]> {
  const files = names.length
    ? names.map((n) => (n.endsWith(".json") ? n : join(dir, `${slugify(n) || n}.json`)))
    : (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, replay: JSON.parse(await readFile(file, "utf8")) as Replay };
      } catch {
        throw new Error(`No replay at ${file}. List them with: ls ${dir}`);
      }
    }),
  );
}

// ---------- running ----------

export interface Divergence {
  step: number;
  action: string;
  reason: string;
  diff?: string;
}

export interface ReplayResult {
  name: string;
  status: "match" | "diverged";
  steps: number;
  durationMs: number;
  runDir: string;
  divergence?: Divergence;
}

const normalize = (aria: string) =>
  aria
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);

/** Line diff that keeps order: "-" expected only, "+" actual only. */
export function ariaDiff(expected: string, actual: string): string | undefined {
  const a = normalize(expected);
  const b = normalize(actual);
  if (a.join("\n") === b.join("\n")) return undefined;
  // LCS table; trees are small.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(`+ ${b[j++]}`);
    } else {
      out.push(`- ${a[i++]}`);
    }
  }
  return collapse(out);
}

/** Keep 3 lines of context around changes; fold long unchanged runs. */
function collapse(lines: string[], context = 3): string {
  const changed = lines.map((l) => l[0] !== " ");
  const keep = lines.map((_, i) => changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) out.push(lines[i]);
    else if (out.at(-1) !== "  …") out.push("  …");
  }
  return out.join("\n");
}

async function perform(page: Page, step: ReplayStep, baseUrl: string): Promise<string> {
  const find = () => {
    const t = step.target!;
    return t.name ? page.getByRole(t.role as any, { name: t.name, exact: true }) : page.getByRole(t.role as any);
  };
  switch (step.action) {
    case "click": {
      const el = find();
      if ((await el.count()) === 0) throw new Error(`${describeTarget(step.target)} not found`);
      await el.first().click();
      return `Clicked ${describeTarget(step.target)}`;
    }
    case "type": {
      const el = find();
      if ((await el.count()) === 0) throw new Error(`${describeTarget(step.target)} not found`);
      await el.first().fill(step.text ?? "");
      if (step.submit) await el.first().press("Enter");
      return `Typed ${JSON.stringify(step.text)}`;
    }
    case "press":
      await page.keyboard.press(step.key!);
      return `Pressed ${step.key}`;
    case "navigate":
      await page.goto(new URL(step.path!, baseUrl).href);
      return `Navigated to ${step.path}`;
    case "reload":
      await page.reload();
      return "Reloaded";
    default:
      throw new Error(`Unexpected step ${step.action}`);
  }
}

export async function runReplay(
  replay: Replay,
  opts: { url: string; runDir: string; headed?: boolean },
): Promise<ReplayResult> {
  const started = Date.now();
  const session = new BrowserSession(opts.runDir, { headed: opts.headed });
  const result = (divergence?: Divergence): ReplayResult => ({
    name: replay.name,
    status: divergence ? "diverged" : "match",
    steps: session.steps.length,
    durationMs: Date.now() - started,
    runDir: opts.runDir,
    divergence,
  });

  try {
    for (const [index, step] of replay.steps.entries()) {
      const rec =
        step.action === "open"
          ? await session.start(new URL(step.path!, opts.url).href)
          : await session.act(step.action, { ...step, expect: undefined }, (page) => perform(page, step, opts.url), step.target);

      let divergence: Divergence | undefined;
      if (!rec.ok) {
        divergence = { step: index, action: step.action, reason: `action failed: ${rec.result}` };
      } else if (rec.consoleErrors.length > step.expect.consoleErrors) {
        divergence = { step: index, action: step.action, reason: `new console errors: ${rec.consoleErrors.join(" | ")}` };
      } else {
        const diff = ariaDiff(step.expect.aria, rec.aria);
        if (diff) divergence = { step: index, action: step.action, reason: "page differs from the recorded run", diff };
      }
      if (divergence) {
        await writeFile(join(opts.runDir, "replay.json"), JSON.stringify(result(divergence), null, 2));
        return result(divergence);
      }
    }
    const ok = result();
    await writeFile(join(opts.runDir, "replay.json"), JSON.stringify(ok, null, 2));
    return ok;
  } finally {
    await session.stop();
  }
}

// ---------- export to a plain Playwright test ----------

const q = (s: string) => JSON.stringify(s);

export function toPlaywrightSpec(replay: Replay): string {
  const lines: string[] = [];
  const expectAria = (aria: string) =>
    lines.push(`  await expect(page.locator("body")).toMatchAriaSnapshot(${q(aria)});`);
  const locate = (t: Target) =>
    t.name ? `page.getByRole(${q(t.role)}, { name: ${q(t.name)}, exact: true })` : `page.getByRole(${q(t.role)})`;

  for (const step of replay.steps) {
    switch (step.action) {
      case "open":
      case "navigate":
        lines.push(`  await page.goto(new URL(${q(step.path!)}, BASE).href);`);
        break;
      case "reload":
        lines.push(`  await page.reload();`);
        break;
      case "press":
        lines.push(`  await page.keyboard.press(${q(step.key!)});`);
        break;
      case "click":
        lines.push(`  await ${locate(step.target!)}.click();`);
        break;
      case "type":
        lines.push(`  await ${locate(step.target!)}.fill(${q(step.text ?? "")});`);
        if (step.submit) lines.push(`  await ${locate(step.target!)}.press("Enter");`);
        break;
    }
    expectAria(step.expect.aria);
  }

  return `// Generated by Witness (${basename(replay.name)}) from verified run ${replay.fromRun}.
// Goal: ${replay.goal.replace(/\n/g, " ")}
// Regenerate with: witness export ${q(replay.name)}
import { test, expect } from "@playwright/test";

const BASE = process.env.WITNESS_URL ?? ${q(replay.recordedUrl)};

test(${q(replay.goal)}, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
${lines.join("\n")}
  expect(errors).toEqual([]);
});
`;
}
