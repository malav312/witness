// Replay: a passing verification, saved as deterministic steps plus the
// accessibility tree expected after each one. Re-running a replay needs no
// LLM: it's fast and free, and the model is only needed again when the app
// stops matching.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { Page } from "playwright";
import { authWarnings } from "./auth.js";
import { BrowserSession, type StepRecord, type Target } from "./browser.js";
import { gitInfo, provenance, type Provenance } from "./provenance.js";
import type { IgnoredError } from "./noise.js";
import type { RunReport } from "./report.js";
import { redact } from "./secrets.js";

export interface ReplayStep {
  action: "open" | "click" | "type" | "select_option" | "click_at" | "press" | "navigate" | "reload";
  target?: Target;
  /** May contain {{secret:NAME}} placeholders, resolved only when typing. */
  text?: string;
  option?: string;
  x?: number;
  y?: number;
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
  /**
   * Live data: lines whose numbers change between runs (counters, timestamps,
   * uptime %), stored with digits masked as "#". Learned by --heal after the
   * agent re-verified the goal; extend it by hand if needed.
   */
  volatile?: string[];
  /** Regexes for lines to ignore entirely when comparing. Edit by hand. */
  ignore?: string[];
  /** The code and build the replay was recorded against. */
  recordedWith?: { commit?: string; build: string };
}

export const REPLAY_DIR = ".witness/replays";

export function slugify(goal: string): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug.length <= 60) return slug;
  const cut = slug.slice(0, 61);
  return cut.slice(0, cut.lastIndexOf("-")); // end on a whole word
}

/** Unique per goal: readable slug plus a short hash of the full goal. */
export const replayName = (goal: string) =>
  `${slugify(goal)}-${createHash("sha1").update(goal).digest("hex").slice(0, 6)}`;

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
      case "click_at":
        steps.push({ action: "click_at", x: input.x, y: input.y, expect });
        break;
      case "select_option":
        if (!s.target) return { error: `step ${s.index} (select_option) has no stable target to replay` };
        steps.push({ action: "select_option", target: s.target, option: input.option, expect });
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
    name: replayName(report.goal),
    goal: report.goal,
    recordedAt: new Date().toISOString(),
    recordedUrl: report.url,
    fromRun: report.id,
    ...(report.provenance
      ? { recordedWith: { commit: report.provenance.git?.commit, build: report.provenance.build.fingerprint } }
      : {}),
    steps,
  };
}

/**
 * A re-verified (healed) replay: same name, so it replaces the old one, plus
 * the lines that changed only in their numbers, learned as live data.
 */
export function rerecord(old: Replay, report: RunReport, divergence?: Divergence): Replay | { error: string } {
  const fresh = replayFromRun(report);
  if ("error" in fresh) return fresh;
  const volatile = [...new Set([...(old.volatile ?? []), ...(divergence?.numericLines ?? [])])];
  return { ...fresh, name: old.name, ...(volatile.length ? { volatile } : {}), ...(old.ignore ? { ignore: old.ignore } : {}) };
}

export async function saveReplay(replay: Replay, dir = REPLAY_DIR): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${replay.name}.json`);
  await writeFile(file, JSON.stringify(replay, null, 2) + "\n");
  return file;
}

export async function loadReplays(names: string[], dir = REPLAY_DIR): Promise<{ file: string; replay: Replay }[]> {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
  const all = await Promise.all(
    files.map(async (file) => ({ file, replay: JSON.parse(await readFile(file, "utf8")) as Replay })),
  );
  if (!names.length) return all;
  // Match by exact name, file path, goal text, or a unique name prefix.
  return names.map((n) => {
    const exact = all.filter(({ file, replay: r }) => r.name === n || file === n || r.goal === n);
    const hits = exact.length ? exact : all.filter(({ replay: r }) => r.name.startsWith(slugify(n) || n));
    if (hits.length === 1) return hits[0];
    throw new Error(
      hits.length ? `"${n}" matches ${hits.length} replays: ${hits.map((h) => h.replay.name).join(", ")}` : `No replay matches "${n}". List them with: ls ${dir}`,
    );
  });
}

// ---------- running ----------

export interface Divergence {
  step: number;
  action: string;
  reason: string;
  diff?: string;
  /** True when every changed line differs only in its numbers: likely live data. */
  numbersOnly?: boolean;
  /** Digit-masked forms of the lines that changed only in their numbers. */
  numericLines?: string[];
}

export interface ReplayResult {
  name: string;
  status: "match" | "diverged";
  steps: number;
  durationMs: number;
  runDir: string;
  divergence?: Divergence;
  /** Which code and build this replay ran against. */
  provenance?: Provenance;
  /** Errors matching the ignore list, left out of the comparison. */
  ignoredErrors?: IgnoredError[];
  /**
   * The browser loaded the same JavaScript as when the replay was recorded.
   * A divergence then comes from data or the environment, not the frontend code.
   */
  sameBuild?: boolean;
}

export const maskDigits = (line: string) => line.replace(/\d+(?:[.,:]\d+)*/g, "#");

export interface Mask {
  volatile?: string[];
  ignore?: string[];
}

function normalize(aria: string, mask: Mask = {}): string[] {
  const volatile = new Set(mask.volatile ?? []);
  const ignore = (mask.ignore ?? []).map((r) => new RegExp(r));
  return aria
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !ignore.some((re) => re.test(l)))
    .map((l) => (volatile.has(maskDigits(l)) ? maskDigits(l) : l));
}

/** Changed lines that differ only in their numbers, digit-masked. */
export function numericChanges(diff: string): { lines: string[]; numbersOnly: boolean } {
  const removed = diff.split("\n").filter((l) => l.startsWith("- ")).map((l) => maskDigits(l.slice(2)));
  const added = diff.split("\n").filter((l) => l.startsWith("+ ")).map((l) => maskDigits(l.slice(2)));
  const lines = [...new Set(removed.filter((l) => added.includes(l)))];
  const numbersOnly = removed.length + added.length > 0 && [...removed, ...added].every((l) => lines.includes(l));
  return { lines, numbersOnly };
}

/** Line diff that keeps order: "-" expected only, "+" actual only. */
export function ariaDiff(expected: string, actual: string, mask: Mask = {}): string | undefined {
  const a = normalize(expected, mask);
  const b = normalize(actual, mask);
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

/** An accessible name with its numbers as wildcards, for names that embed live data ("18 checks, 0 up"). */
export const nameWithLiveNumbers = (name: string) =>
  new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+(?:[.,:]\d+)*/g, "\\d+(?:[.,:]\\d+)*")}$`);

async function perform(session: BrowserSession, page: Page, step: ReplayStep, baseUrl: string): Promise<string> {
  // Exact name first; if that's gone and the name has numbers in it, match it with the numbers as wildcards.
  const locate = async () => {
    const t = step.target!;
    if (!t.name) return page.getByRole(t.role as any);
    const exact = page.getByRole(t.role as any, { name: t.name, exact: true });
    if ((await exact.count()) > 0 || !/\d/.test(t.name)) return exact;
    return page.getByRole(t.role as any, { name: nameWithLiveNumbers(t.name) });
  };
  switch (step.action) {
    case "click": {
      const el = await locate();
      if ((await el.count()) === 0) throw new Error(`${describeTarget(step.target)} not found`);
      await el.first().click();
      return `Clicked ${describeTarget(step.target)}`;
    }
    case "type": {
      const el = await locate();
      if ((await el.count()) === 0) throw new Error(`${describeTarget(step.target)} not found`);
      await session.fill(el.first(), step.text ?? "");
      if (step.submit) await el.first().press("Enter");
      return `Typed ${JSON.stringify(step.text)}`;
    }
    case "select_option": {
      const el = await locate();
      if ((await el.count()) === 0) throw new Error(`${describeTarget(step.target)} not found`);
      await el.first().selectOption({ label: step.option! }).catch(() => el.first().selectOption(step.option!));
      return `Selected ${JSON.stringify(step.option)}`;
    }
    case "click_at":
      await page.mouse.click(step.x!, step.y!);
      return `Clicked at (${step.x}, ${step.y})`;
    case "press":
      await page.keyboard.press(step.key!);
      return `Pressed ${step.key}`;
    case "navigate":
      await session.goto(new URL(step.path!, baseUrl).href);
      return `Navigated to ${step.path}`;
    case "reload":
      await session.reload();
      return "Reloaded";
    default:
      throw new Error(`Unexpected step ${step.action}`);
  }
}

export async function runReplay(
  replay: Replay,
  opts: { url: string; runDir: string; headed?: boolean; storageState?: string },
): Promise<ReplayResult> {
  const started = Date.now();
  const session = new BrowserSession(opts.runDir, { headed: opts.headed, storageState: opts.storageState });
  const result = async (divergence?: Divergence): Promise<ReplayResult> => {
    const tested = provenance(await session.build().catch(() => ({ fingerprint: "none", scripts: [], serviceWorker: false })), gitInfo(), opts.url);
    tested.warnings.push(...authWarnings(opts.storageState));
    const was = replay.recordedWith?.build;
    return {
      name: replay.name,
      status: divergence ? "diverged" : "match",
      steps: session.steps.length,
      durationMs: Date.now() - started,
      runDir: opts.runDir,
      divergence,
      provenance: tested,
      ignoredErrors: session.ignoredErrors().map((e) => ({ ...e, example: redact(e.example) })),
      ...(was && was !== "none" && tested.build.fingerprint !== "none" ? { sameBuild: was === tested.build.fingerprint } : {}),
    };
  };

  try {
    for (const [index, step] of replay.steps.entries()) {
      const rec =
        step.action === "open"
          ? await session.start(new URL(step.path!, opts.url).href)
          : await session.act(step.action, { ...step, expect: undefined }, (page) => perform(session, page, step, opts.url), step.target);

      let divergence: Divergence | undefined;
      if (!rec.ok) {
        divergence = { step: index, action: step.action, reason: `action failed: ${rec.result}` };
      } else if (rec.consoleErrors.length > step.expect.consoleErrors) {
        divergence = { step: index, action: step.action, reason: `new console errors: ${rec.consoleErrors.join(" | ")}` };
      } else {
        const diff = ariaDiff(step.expect.aria, rec.aria, replay);
        if (diff) {
          const { lines, numbersOnly } = numericChanges(diff);
          divergence = {
            step: index,
            action: step.action,
            reason: numbersOnly ? "only numbers changed (live data?)" : "page differs from the recorded run",
            diff,
            numbersOnly,
            numericLines: lines,
          };
        }
      }
      if (divergence) {
        const out = await result(divergence);
        await writeFile(join(opts.runDir, "replay.json"), JSON.stringify(out, null, 2));
        return out;
      }
    }
    const ok = await result();
    await writeFile(join(opts.runDir, "replay.json"), JSON.stringify(ok, null, 2));
    return ok;
  } finally {
    await session.stop();
  }
}

// ---------- export to a plain Playwright test ----------

const q = (s: string) => JSON.stringify(s);
/** A string literal where {{secret:NAME}} placeholders read the env at test time. */
const qs = (s: string) => q(s).replace(/\{\{secret:([A-Za-z0-9_]+)\}\}/g, (_, n) => `" + secret(${q(n.toUpperCase())}) + "`);

export function toPlaywrightSpec(replay: Replay): string {
  const lines: string[] = [];
  const volatile = new Set(replay.volatile ?? []);
  const ignore = (replay.ignore ?? []).map((r) => new RegExp(r));
  // Aria snapshot matching is partial, so live-data and ignored lines are simply left out.
  const stable = (aria: string) =>
    aria
      .split("\n")
      .filter((l) => !volatile.has(maskDigits(l.trimEnd())) && !ignore.some((re) => re.test(l)))
      .join("\n");
  const expectAria = (aria: string) => {
    const kept = stable(aria);
    if (kept.trim()) lines.push(`  await expect(page.locator("body")).toMatchAriaSnapshot(${qs(kept)});`);
  };
  const locate = (t: Target) =>
    !t.name
      ? `page.getByRole(${q(t.role)})`
      : /\d/.test(t.name)
        ? `page.getByRole(${q(t.role)}, { name: ${nameWithLiveNumbers(t.name)} })`
        : `page.getByRole(${q(t.role)}, { name: ${q(t.name)}, exact: true })`;

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
      case "select_option":
        lines.push(`  await ${locate(step.target!)}.selectOption({ label: ${q(step.option!)} });`);
        break;
      case "click_at":
        lines.push(`  await page.mouse.click(${step.x}, ${step.y});`);
        break;
      case "type":
        lines.push(`  await ${locate(step.target!)}.fill(${qs(step.text ?? "")});`);
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
const secret = (name: string) => {
  const value = process.env[\`WITNESS_SECRET_\${name}\`];
  if (!value) throw new Error(\`Set WITNESS_SECRET_\${name} to run this test\`);
  return value;
};

test(${q(replay.goal)}, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
${lines.join("\n")}
  expect(errors).toEqual([]);
});
`;
}
