// A Playwright session that records everything as evidence.
// The driver acts through this; the judge only ever sees what it recorded.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readAuthExtra, restoreSessionStorage } from "./auth.js";
import { loadIgnoreRules, type IgnoredError, type IgnoreRule } from "./noise.js";
import { fingerprintOf, sha256, type BuildInfo, type ScriptInfo } from "./provenance.js";
import { hasSecrets, loadSecrets, redactDeep, resolveSecrets } from "./secrets.js";
import type { Locator } from "playwright";

/**
 * Parse the first node of an aria snapshot line, e.g. `- button "Add" [ref=e5]`.
 * Playwright wraps a line in YAML single quotes when it contains ": ", as in
 * `- 'link "Monitor: 18 checks" [ref=e56]':`, so unwrap that first.
 */
export function parseAriaNode(line: string): Target | undefined {
  let body = line.trim().replace(/^- /, "");
  if (body.startsWith("'")) {
    // Find the closing quote; inside, a literal ' is written as ''.
    let end = 1;
    while (end < body.length) {
      if (body[end] === "'" && body[end + 1] === "'") end += 2;
      else if (body[end] === "'") break;
      else end++;
    }
    body = body.slice(1, end).replace(/''/g, "'");
  }
  const m = body.match(/^([a-z][\w-]*)(?: ("(?:[^"\\]|\\.)*"))?/i);
  return m ? { role: m[1], name: m[2] ? JSON.parse(m[2]) : "" } : undefined;
}

/**
 * Origins the browser may load pages from: the app's own, plus any listed in
 * WITNESS_ALLOWED_ORIGINS (comma-separated, e.g. an identity provider for login).
 * Everything else is blocked, so text in the app under test can't steer the
 * Driver to local files or other sites, and secrets are only typed where allowed.
 */
export function allowedOrigins(appUrl: string): Set<string> {
  const extra = (process.env.WITNESS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin);
  return new Set([new URL(appUrl).origin, ...extra]);
}

// Chromium-based browsers Playwright has no channel for, at their usual install paths.
const KNOWN_PATHS: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  brave: {
    darwin: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", `${process.env.HOME}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`],
    win32: [
      `${process.env.PROGRAMFILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ],
    linux: ["/usr/bin/brave-browser", "/usr/bin/brave", "/snap/bin/brave", "/opt/brave.com/brave/brave"],
  },
};

/** Turn --channel into launch options: a Playwright channel, a known browser, or a path to one. */
export function browserLaunchOptions(channel = process.env.WITNESS_BROWSER_CHANNEL?.trim()): { channel?: string; executablePath?: string } {
  if (!channel) return {};
  const known = KNOWN_PATHS[channel.toLowerCase()];
  if (known) {
    const found = (known[process.platform] ?? []).find((p) => existsSync(p));
    if (!found) throw new Error(`Couldn't find ${channel} in its usual install location. Pass the path to it instead: --channel "/path/to/${channel}"`);
    return { executablePath: found };
  }
  // A path (has a slash or backslash) is a Chromium-based browser's executable.
  if (/[\\/]/.test(channel)) {
    if (!existsSync(channel)) throw new Error(`No browser at ${channel} (--channel / WITNESS_BROWSER_CHANNEL).`);
    return { executablePath: channel };
  }
  return { channel };
}

/**
 * Launch Chromium, or an installed browser named by WITNESS_BROWSER_CHANNEL
 * (--channel): msedge, chrome, chrome-beta..., brave, or the path to any
 * Chromium-based browser. On locked-down machines the Chromium Playwright
 * downloads may not be allowed to run, but an installed browser is.
 */
export async function launchBrowser(headless = true): Promise<Browser> {
  const channel = process.env.WITNESS_BROWSER_CHANNEL?.trim() || undefined;
  const launch = browserLaunchOptions(channel);
  try {
    return await chromium.launch({ headless, ...launch });
  } catch (err) {
    const why = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      channel
        ? `Could not start the "${channel}" browser (--channel / WITNESS_BROWSER_CHANNEL). Is it installed? ${why}`
        : `Could not start Playwright's Chromium. Install it with "npx playwright install chromium", ` +
            `or use an installed browser with --channel msedge, chrome or brave. ${why}`,
    );
  }
}

// After a page load, wait for network activity to settle, up to this long.
// Apps that poll or stream never settle, so this is only a cap.
const NETWORK_IDLE_CAP_MS = 5000;

/**
 * Wait until a freshly loaded page is ready to look at: the network has gone
 * quiet (capped), and WITNESS_READY_SELECTOR is visible if set, for app shells
 * that show a spinner or skeleton first. Returns a note if the selector never showed.
 */
export async function waitReady(page: Page): Promise<string | undefined> {
  const selector = process.env.WITNESS_READY_SELECTOR?.trim();
  const timeout = Number(process.env.WITNESS_READY_TIMEOUT_MS ?? 15000);
  let note: string | undefined;
  if (selector) {
    await page.locator(selector).first().waitFor({ state: "visible", timeout }).catch(() => {
      note = `ready selector ${JSON.stringify(selector)} did not appear within ${timeout / 1000}s`;
    });
  }
  await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS }).catch(() => {});
  return note;
}

export interface Target {
  role: string;
  name: string;
}

export interface StepRecord {
  index: number;
  action: string;
  input: Record<string, unknown>;
  ok: boolean;
  result: string;
  url: string;
  screenshot: string; // path relative to the run directory
  consoleErrors: string[]; // new since the previous step
  failedRequests: string[]; // new since the previous step
  dialogs: string[]; // alert/confirm/prompt shown during the step (accepted)
  snapshot: string; // accessibility tree after the step, with [ref=eN] markers
  aria: string; // same tree in Playwright's stable format, used by replays
  target?: Target; // role + accessible name of the element acted on
  at: string;
}

export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  readonly steps: StepRecord[] = [];
  readonly allConsoleErrors: string[] = [];
  readonly allFailedRequests: string[] = [];
  private pendingConsole: string[] = [];
  private pendingRequests: string[] = [];
  private pendingDialogs: string[] = [];
  private tracing = false;
  // Same-origin scripts the browser loaded, for the build fingerprint.
  private origin = "";
  private scripts = new Map<string, Promise<ScriptInfo | undefined>>();
  private firstPageScripts = new Set<string>();
  private firstPageLoaded = false;
  private allowed = new Set<string>(); // pages may load from these
  private secretOrigins = new Set<string>(); // secrets may be typed here (no auto-learned sign-in sites)
  private blocked: string[] = [];
  private ignoreRules: IgnoreRule[] = [];
  private ignored = new Map<string, IgnoredError>();

  constructor(
    private readonly runDir: string,
    private readonly opts: { headed?: boolean; storageState?: string } = {},
  ) {}

  async start(url: string) {
    await mkdir(join(this.runDir, "screens"), { recursive: true });
    this.ignoreRules = loadIgnoreRules();
    this.browser = await launchBrowser(!this.opts.headed);
    // Fresh context per run: no cookies or localStorage leak between runs.
    // WITNESS_VIDEO=<dir> records the session (for demos); off by default.
    const video = process.env.WITNESS_VIDEO;
    const viewport = video ? { width: 640, height: 400 } : { width: 1280, height: 800 };
    this.context = await this.browser.newContext({
      viewport,
      // A saved login (see `witness auth`), so runs start signed in.
      ...(this.opts.storageState ? { storageState: this.opts.storageState } : {}),
      ...(video ? { recordVideo: { dir: video, size: viewport } } : {}),
    });
    // A Playwright trace stores raw DOM and network data, including typed
    // values, and can't be redacted afterwards. With secrets configured, skip it.
    this.tracing = loadSecrets().size === 0;
    if (this.tracing) await this.context.tracing.start({ screenshots: true, snapshots: true });
    this.secretOrigins = allowedOrigins(url);
    this.allowed = new Set(this.secretOrigins);
    // Signed in with `witness auth --manual`: the identity provider's sites seen
    // during sign-in may load too (token refresh), and sessionStorage is restored.
    const extra = readAuthExtra(this.opts.storageState);
    if (extra?.appOrigin === new URL(url).origin) {
      for (const o of extra.signInOrigins) this.allowed.add(o);
      await restoreSessionStorage(this.context, extra);
    }
    // Block page loads (top-level or in frames) from anywhere else.
    await this.context.route("**/*", (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && !this.isAllowed(req.url())) {
        this.blocked.push(req.url());
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(5000);

    this.page.on("console", (msg) => {
      if (msg.type() === "error") this.recordConsole(`console.error: ${msg.text()}`);
    });
    this.page.on("pageerror", (err) => this.recordConsole(`uncaught: ${err.message}`));
    // A real user answers dialogs; Playwright would silently dismiss them.
    // Accept, and keep the text as evidence.
    this.page.on("dialog", (d) => {
      this.pendingDialogs.push(`${d.type()} "${d.message()}" → accepted`);
      d.accept().catch(() => {});
    });
    this.page.on("requestfailed", (req) =>
      this.recordRequest(`${req.method()} ${req.url()} failed: ${req.failure()?.errorText}`),
    );
    this.page.on("response", (res) => {
      if (res.status() >= 400) this.recordRequest(`${res.request().method()} ${res.url()} -> ${res.status()}`);
      else this.recordScript(res);
    });

    this.origin = new URL(url).origin;
    await this.page.goto(url);
    const note = await waitReady(this.page);
    this.firstPageLoaded = true;
    return this.record("navigate", { url }, true, `Opened ${url}${note ? ` (${note})` : ""}`);
  }

  /** True for http(s) URLs on an allowed origin. */
  isAllowed(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === "http:" || u.protocol === "https:") && this.allowed.has(u.origin);
    } catch {
      return false;
    }
  }

  /** Navigate within the app; refuses other origins and non-http(s) URLs. */
  async goto(url: string) {
    const target = new URL(url, this.page.url()).href;
    if (!this.isAllowed(target)) {
      throw new Error(
        `Blocked: ${new URL(target).protocol.startsWith("http") ? new URL(target).origin : target} is outside the app. ` +
          `Only ${[...this.allowed].join(", ")} can be opened (add origins with WITNESS_ALLOWED_ORIGINS).`,
      );
    }
    const res = await this.page.goto(target);
    await waitReady(this.page);
    return res;
  }

  async reload() {
    await this.page.reload();
    await waitReady(this.page);
  }

  /** Fill a field, substituting {{secret:NAME}} only if the field is on an allowed origin. */
  async fill(el: Locator, text: string) {
    if (hasSecrets(text)) {
      const origin = await el.evaluate(() => location.origin);
      if (!this.secretOrigins.has(origin)) throw new Error(`Refused to type a secret into a field on ${origin}, which is outside the app`);
    }
    await el.fill(resolveSecrets(text));
  }

  private recordScript(res: import("playwright").Response) {
    if (res.request().resourceType() !== "script") return;
    const u = new URL(res.url());
    if (u.origin !== this.origin || this.scripts.has(u.href)) return;
    const path = u.pathname + u.search;
    if (!this.firstPageLoaded) this.firstPageScripts.add(path);
    this.scripts.set(
      u.href,
      res
        .body()
        .then((body) => ({
          url: path,
          sha256: sha256(body),
          bytes: body.length,
          lastModified: res.headers()["last-modified"],
          fromServiceWorker: res.fromServiceWorker(),
        }))
        .catch(() => undefined),
    );
  }

  /** Which build the browser actually ran: script hashes, Last-Modified, service worker. */
  async build(): Promise<BuildInfo> {
    const scripts = (await Promise.all(this.scripts.values())).filter((s): s is ScriptInfo => !!s);
    const serviceWorker = await this.page
      ?.evaluate(() => !!navigator.serviceWorker?.controller)
      .catch(() => false);
    return {
      fingerprint: fingerprintOf(scripts.filter((s) => this.firstPageScripts.has(s.url))),
      scripts,
      serviceWorker: !!serviceWorker,
    };
  }

  /** Known-noise errors that were left out of the evidence, by pattern. */
  ignoredErrors(): IgnoredError[] {
    return [...this.ignored.values()];
  }

  private isNoise(line: string): boolean {
    const r = this.ignoreRules.find((r) => r.test(line));
    if (!r) return false;
    const seen = this.ignored.get(r.pattern);
    if (seen) seen.count++;
    else this.ignored.set(r.pattern, { pattern: r.pattern, count: 1, example: line.slice(0, 300) });
    return true;
  }

  private recordConsole(line: string) {
    if (this.isNoise(line)) return;
    this.pendingConsole.push(line);
    this.allConsoleErrors.push(line);
  }

  private recordRequest(line: string) {
    if (this.isNoise(line)) return;
    this.pendingRequests.push(line);
    this.allFailedRequests.push(line);
  }

  /** Role and accessible name of an element, so a replay can find it again without refs. */
  async describe(ref: string): Promise<Target | undefined> {
    try {
      const first = (await this.page.locator(`aria-ref=${ref}`).ariaSnapshot({ mode: "ai", timeout: 2000 })).split("\n")[0];
      return parseAriaNode(first);
    } catch {
      return undefined;
    }
  }

  /** Accessibility snapshot with [ref=eN] markers the driver can target. */
  async snapshot(): Promise<string> {
    return this.page.ariaSnapshot({ mode: "ai" });
  }

  /** Run one action, then screenshot and log it, whether it succeeded or not. */
  async act(
    action: string,
    input: Record<string, unknown>,
    fn: (page: Page) => Promise<string | void>,
    target?: Target,
  ): Promise<StepRecord> {
    let ok = true;
    let result: string;
    try {
      result = (await fn(this.page)) ?? "done";
      // Let handlers, re-renders and async errors land before we look.
      await this.page.waitForLoadState("domcontentloaded");
      await this.page.waitForTimeout(250);
    } catch (err) {
      ok = false;
      result = err instanceof Error ? err.message.split("\n")[0] : String(err);
    }
    // A link or script tried to leave the app: the load was blocked. If the
    // page is now Chrome's error page, go back so the run can continue.
    const blocked = this.blocked.splice(0);
    if (blocked.length) {
      if (!this.isAllowed(this.page.url())) await this.page.goBack().catch(() => {});
      ok = false;
      result =
        `Blocked a page load outside the app (${blocked.map((u) => (u.startsWith("http") ? new URL(u).origin : u.slice(0, 40))).join(", ")}); stayed on ${this.page.url()}. ` +
        `If that is your sign-in provider, sign in once with "witness auth --manual", or add it to WITNESS_ALLOWED_ORIGINS.`;
    }
    return this.record(action, input, ok, result, target);
  }

  private async record(
    action: string,
    input: Record<string, unknown>,
    ok: boolean,
    result: string,
    target?: Target,
  ): Promise<StepRecord> {
    const index = this.steps.length;
    const screenshot = join("screens", `${String(index).padStart(3, "0")}-${action}.png`);
    await this.screenshotMasked(join(this.runDir, screenshot));
    // Order matters: a default-mode snapshot invalidates [ref=eN] markers, so
    // take it first and the ref snapshot the driver will target last.
    const aria = await this.page.ariaSnapshot().catch(() => "(snapshot unavailable)");
    const snapshot = await this.snapshot().catch(() => "(snapshot unavailable)");
    // Everything recorded is redacted: secret values become {{secret:NAME}}.
    const step: StepRecord = redactDeep({
      index,
      action,
      input,
      ok,
      result,
      url: this.page.url(),
      screenshot,
      consoleErrors: this.pendingConsole.splice(0),
      failedRequests: this.pendingRequests.splice(0),
      dialogs: this.pendingDialogs.splice(0),
      snapshot,
      aria,
      target,
      at: new Date().toISOString(),
    });
    this.steps.push(step);
    return step;
  }

  /** Screenshot with any field that currently holds a secret value blacked out. */
  private async screenshotMasked(path: string) {
    const values = [...loadSecrets().values()].filter((v) => v.length >= 3);
    if (values.length) {
      await this.page
        .evaluate((vals) => {
          for (const el of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) {
            if (el.type !== "password" && vals.some((v) => el.value.includes(v))) el.setAttribute("data-witness-secret", "");
            else el.removeAttribute("data-witness-secret");
          }
        }, values)
        .catch(() => {});
    }
    await this.page
      .screenshot({ path, mask: values.length ? [this.page.locator("[data-witness-secret]")] : [] })
      .catch(() => {});
  }

  /** Save cookies and localStorage (e.g. a login) for later sessions. */
  async saveState(path: string) {
    await this.context.storageState({ path, indexedDB: true });
  }

  async stop() {
    if (this.tracing) await this.context.tracing.stop({ path: join(this.runDir, "trace.zip") }).catch(() => {});
    await this.browser.close();
  }
}
