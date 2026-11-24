// The Mapper: builds a Feature Map, a short index of what the app does, how
// to reach each feature, which controls it uses, and the traps worth knowing.
// The Driver reads it first. The app stays the source of truth.
//
//   crawl     deterministic: every same-origin page, its title and controls
//   describe  one model call: turn the crawl + lessons from past runs into features
//   check     deterministic: re-crawl and report drift against the saved map
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Backend } from "./driver.js";
import { MODEL, client, requestDefaults } from "./claude.js";
import { runClaudeCode } from "./claude-code.js";
import { launchBrowser, parseAriaNode, waitReady } from "./browser.js";
import { readAuthExtra, restoreSessionStorage } from "./auth.js";
import { checkBackend } from "./preflight.js";
import { maskDigits } from "./replay.js";

export const MAP_FILE = "witness.map.yaml";

// ---------- crawl ----------

export interface CrawlPage {
  path: string;
  title: string;
  controls: string[]; // e.g. button "Add", textbox "New task"
  aria: string;
  screenshot: string;
}

const CONTROL_ROLES = new Set(
  "button link textbox searchbox checkbox radio switch combobox listbox slider spinbutton tab menuitem option".split(" "),
);

/** Interactive controls on a page, e.g. button "Add". Numbers are masked (#) so live counts aren't drift. */
export function controlsOf(aria: string): string[] {
  const out = new Set<string>();
  for (const line of aria.split("\n")) {
    const node = parseAriaNode(line);
    if (node && CONTROL_ROLES.has(node.role)) out.add(node.name ? `${node.role} ${JSON.stringify(maskDigits(node.name))}` : node.role);
  }
  return [...out];
}

export async function crawl(startUrl: string, outDir: string, maxPages = 20, storageState?: string): Promise<CrawlPage[]> {
  await mkdir(outDir, { recursive: true });
  const origin = new URL(startUrl).origin;
  const browser = await launchBrowser();
  // A fresh context, as a new user first sees the app, or signed in with a
  // saved login (`witness auth`) so the crawl gets past the login page.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(storageState ? { storageState } : {}),
  });
  await restoreSessionStorage(context, readAuthExtra(storageState));
  const page = await context.newPage();
  const queue = [new URL(startUrl).pathname + new URL(startUrl).search];
  const seen = new Set(queue);
  const pages: CrawlPage[] = [];
  try {
    while (queue.length && pages.length < maxPages) {
      const path = queue.shift()!;
      await page.goto(origin + path);
      await waitReady(page);
      const aria = await page.ariaSnapshot();
      const screenshot = join(outDir, `page-${pages.length}.png`);
      await page.screenshot({ path: screenshot });
      pages.push({ path, title: await page.title(), controls: controlsOf(aria), aria, screenshot });

      const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
      for (const href of links) {
        const u = new URL(href);
        if (u.origin !== origin) continue;
        const p = u.pathname + u.search;
        if (!seen.has(p)) {
          seen.add(p);
          queue.push(p);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return pages;
}

// ---------- lessons from past runs ----------

interface Lesson {
  date: string;
  goal: string;
  verdict: string;
  summary: string;
  problems: string[];
}

/** The newest run per goal: older results for the same goal are superseded. */
async function lessons(runsDir: string, limit = 30): Promise<Lesson[]> {
  const dirs = (await readdir(runsDir).catch(() => [])).sort().reverse();
  const out: Lesson[] = [];
  const goals = new Set<string>();
  for (const d of dirs) {
    if (out.length >= limit) break;
    try {
      const r = JSON.parse(await readFile(join(runsDir, d, "report.json"), "utf8"));
      if (goals.has(r.goal)) continue;
      goals.add(r.goal);
      out.push({ date: r.startedAt.slice(0, 10), goal: r.goal, verdict: r.verdict.verdict, summary: r.verdict.summary, problems: r.verdict.problems });
    } catch {
      // replay runs and unfinished runs have no report.json
    }
  }
  return out;
}

// ---------- describe ----------

const Described = z.object({
  summary: z.string().describe("What the app is for, in one or two sentences"),
  pages: z.array(z.object({ path: z.string(), purpose: z.string() })),
  features: z.array(
    z.object({
      name: z.string(),
      page: z.string().describe("Path of the page the feature lives on"),
      how_to_reach: z.array(z.string()).describe("Steps a user takes to use it, in order"),
      controls: z.array(z.string()).describe('Copied exactly from the crawl, e.g. button "Add"'),
      behavior: z.string().describe("What should happen when it works"),
      traps: z
        .array(z.string())
        .describe("Gotchas a tester should know. Only what the crawl or past runs show; suffix lessons from runs with (from runs)"),
    }),
  ),
});
type Described = z.infer<typeof Described>;

const SYSTEM = `You are the Mapper in Witness, a verification harness. You write the app's Feature Map: a compact index that a testing agent reads before exercising the app.

You get a deterministic crawl (each page's accessibility tree, controls and a screenshot) and lessons from past verification runs.
- Describe features as a user sees them: "Add a task", "Change settings". Group controls that work together.
- Copy control names exactly from the crawl; never invent controls.
- Note dynamic controls that only appear later (for example per-item buttons once items exist) in how_to_reach or traps.
- traps: things that would trip up a tester, such as settings on another page that change behavior elsewhere, confirmation dialogs, state persisting across reloads, and controls that look alike. Base them on evidence only.
- Lessons from runs describe the app as it was on that date, and a failure may since have been fixed. Write them as things to check ("reload to confirm tasks persist; a run on 2026-11-22 found they did not"), never as current facts about the app.
- Keep it short. This is an index, not documentation.`;

function crawlText(pages: CrawlPage[], past: Lesson[]): string {
  const p = pages
    .map((pg) => `## ${pg.path}  (title: ${pg.title})\nControls: ${pg.controls.join(", ") || "none"}\nAccessibility tree:\n${pg.aria}`)
    .join("\n\n");
  const l = past.length
    ? past.map((x) => `- ${x.date} [${x.verdict}] ${x.goal}\n  ${x.summary}${x.problems.length ? `\n  problems: ${x.problems.join(" | ")}` : ""}`).join("\n")
    : "(none yet)";
  return `# Crawl\n\n${p}\n\n# Lessons from past runs\n\n${l}`;
}

async function describe(pages: CrawlPage[], past: Lesson[], backend: Backend, workDir: string): Promise<Described> {
  if (backend === "claude-code") {
    const shots = pages.map((p) => `- ${p.path}: ${p.screenshot}`).join("\n");
    const result = await runClaudeCode({
      prompt: `${crawlText(pages, past)}\n\nScreenshots (open with Read if layout matters):\n${shots}`,
      systemPrompt: SYSTEM,
      tools: "Read",
      allowedTools: ["Read"],
      jsonSchema: (({ $schema: _, ...schema }) => schema)(z.toJSONSchema(Described)),
      cwd: workDir,
      addDirs: [workDir],
    });
    const parsed = Described.safeParse(result.structured);
    if (!parsed.success) throw new Error("Mapper returned no structured map");
    return parsed.data;
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: crawlText(pages, past) }];
  for (const p of pages) {
    content.push({ type: "text", text: `Screenshot of ${p.path}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: (await readFile(p.screenshot)).toString("base64") },
    });
  }
  const response = await client.beta.messages.parse({
    ...requestDefaults,
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "medium", format: betaZodOutputFormat(Described) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  if (!response.parsed_output) throw new Error(`Mapper returned no map (stop_reason: ${response.stop_reason})`);
  return response.parsed_output;
}

// ---------- the map file ----------

export interface FeatureMap {
  generated: string;
  url: string;
  summary: string;
  pages: { path: string; title: string; purpose: string; controls: string[] }[];
  features: Described["features"];
}

export async function buildMap(opts: {
  url: string;
  backend: Backend;
  workDir: string;
  runsDir: string;
  storageState?: string;
  log?: (l: string) => void;
}): Promise<FeatureMap> {
  const log = opts.log ?? (() => {});
  await checkBackend(opts.backend);
  log(`  crawling ${opts.url}…`);
  const pages = await crawl(opts.url, opts.workDir, 20, opts.storageState);
  log(`  found ${pages.length} page(s): ${pages.map((p) => p.path).join(", ")}`);
  const past = await lessons(opts.runsDir);
  log(`  describing features (${past.length} past run(s) as lessons) via ${opts.backend}…`);
  const d = await describe(pages, past, opts.backend, opts.workDir);
  const purpose = new Map(d.pages.map((p) => [p.path, p.purpose]));
  return {
    generated: new Date().toISOString(),
    url: opts.url,
    summary: d.summary,
    // Pages and controls come from the crawl, not the model, so --check can diff them.
    pages: pages.map((p) => ({ path: p.path, title: p.title, purpose: purpose.get(p.path) ?? "", controls: p.controls })),
    features: d.features,
  };
}

export async function writeMap(map: FeatureMap, file = MAP_FILE) {
  const header =
    "# Witness Feature Map: how to reach and operate this app, for testing agents.\n" +
    "# Regenerate with `witness map`, check for drift with `witness map --check`.\n" +
    "# Safe to edit and commit. The app is the source of truth.\n";
  await writeFile(file, header + YAML.stringify(map, { lineWidth: 0 }));
}

export async function readMap(file = MAP_FILE): Promise<{ map: FeatureMap; text: string } | undefined> {
  try {
    const text = await readFile(file, "utf8");
    return { map: YAML.parse(text) as FeatureMap, text };
  } catch {
    return undefined;
  }
}

// ---------- drift check ----------

export interface Drift {
  addedPages: string[];
  removedPages: string[];
  changedPages: { path: string; added: string[]; removed: string[] }[];
  staleFeatures: { name: string; missing: string[] }[];
}

export async function checkMap(map: FeatureMap, url: string, workDir: string, storageState?: string): Promise<Drift> {
  const pages = await crawl(url, workDir, 20, storageState);
  const now = new Map(pages.map((p) => [p.path, p]));
  const before = new Map(map.pages.map((p) => [p.path, p]));
  const drift: Drift = {
    addedPages: [...now.keys()].filter((p) => !before.has(p)),
    removedPages: [...before.keys()].filter((p) => !now.has(p)),
    changedPages: [],
    staleFeatures: [],
  };
  for (const [path, old] of before) {
    const cur = now.get(path);
    if (!cur) continue;
    const added = cur.controls.filter((c) => !old.controls.includes(c));
    const removed = old.controls.filter((c) => !cur.controls.includes(c));
    if (added.length || removed.length) drift.changedPages.push({ path, added, removed });
  }
  // A feature is stale if a control it relies on is gone from its page.
  // Controls that only exist later (e.g. per-item buttons) were never in the
  // crawl, so only controls the crawl originally saw count.
  for (const f of map.features) {
    const old = before.get(f.page);
    const cur = now.get(f.page);
    const missing = f.controls.filter((c) => old?.controls.includes(c) && !cur?.controls.includes(c));
    if (missing.length || (old && !cur)) drift.staleFeatures.push({ name: f.name, missing: cur ? missing : [`page ${f.page}`] });
  }
  return drift;
}

export const hasDrift = (d: Drift) =>
  d.addedPages.length + d.removedPages.length + d.changedPages.length + d.staleFeatures.length > 0;
