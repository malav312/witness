// No-LLM tests for what a first run on a real company app needed: a backend
// check before the browser opens, an installed browser (--channel), waiting for
// slow app shells, ignoring known-noise errors, and saved logins (expiry,
// sessionStorage, the sign-in site) from `witness auth --manual`.
import http from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AUTH_EXTRA_FILE, AUTH_FILE, authWarnings } from "../src/auth.ts";
import { BrowserSession, browserLaunchOptions, launchBrowser } from "../src/browser.ts";
import { runClaudeCode } from "../src/claude-code.ts";
import { loadIgnoreRules } from "../src/noise.ts";
import { checkBackend } from "../src/preflight.ts";
import { resetSecrets } from "../src/secrets.ts";

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const root = mkdtempSync(join(tmpdir(), "witness-real-"));
const dir = () => mkdtempSync(join(root, "d-"));
const errOf = (p: Promise<unknown>) => p.then(() => "", (e) => String(e?.message ?? e));

// The app: a shell that loads data late, logs telemetry noise, and shows a token from sessionStorage.
const APP = `<!doctype html><title>Shell</title><h1>Shell</h1><main id="root">Loading…</main>
<p id="token"></p><a href="IDP/login">Sign in</a><input aria-label="Password" id="pw">
<button onclick="console.error('real bug: save failed')">Save</button>
<script>
  console.error("appinsights: telemetry blocked by proxy");
  document.getElementById("token").textContent = "token=" + (sessionStorage.getItem("token") || "none");
  setTimeout(() => fetch("/data").then(r => r.text()).then(t => document.getElementById("root").textContent = t), 300);
  setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<nav id=ready>Menu loaded</nav>"), 2500);
</script>`;
const idp = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<title>IdP</title><h1>Sign in</h1><input aria-label="IdP password">`));
await new Promise<void>((r) => idp.listen(0, "localhost", r));
const idpUrl = `http://localhost:${(idp.address() as AddressInfo).port}`;
const app = http.createServer((req, res) => {
  if (req.url === "/data") return setTimeout(() => res.writeHead(200).end("Dashboard: 3 projects"), 1200);
  res.writeHead(200, { "content-type": "text/html" }).end(APP.replace("IDP", idpUrl));
});
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;

const cwd = process.cwd();
const path = process.env.PATH;
try {
  // --- backend preflight and Claude Code error text ---
  const bin = dir();
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!/bin/sh\nif [ "$1" = auth ]; then echo '{"loggedIn": false}'; exit 1; fi\n` +
      `cat > /dev/null; echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'\n`,
  );
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}:${path}`;
  const signedOut = await errOf(checkBackend("claude-code"));
  expect(signedOut.includes("isn't signed in") && signedOut.includes("/login"), `signed-out Claude Code is caught up front: ${signedOut.slice(0, 60)}`);
  const ccErr = await errOf(runClaudeCode({ prompt: "hi", systemPrompt: "", tools: "", allowedTools: [] }));
  expect(!ccErr.includes("(success)") && ccErr.includes("Not logged in") && ccErr.includes("/login"), `error text has no "(success)" and says what to do: ${ccErr.slice(0, 90)}`);
  process.env.PATH = path;
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  expect((await errOf(checkBackend("api"))).includes("needs ANTHROPIC_API_KEY"), "api backend without a key is caught up front");
  if (key) process.env.ANTHROPIC_API_KEY = key;

  // --- browser channel ---
  process.env.WITNESS_BROWSER_CHANNEL = "witness-no-such-browser";
  const chErr = await errOf(launchBrowser());
  expect(chErr.includes('"witness-no-such-browser"') && chErr.includes("--channel"), `a bad channel names itself: ${chErr.slice(0, 80)}`);
  delete process.env.WITNESS_BROWSER_CHANNEL;
  expect(browserLaunchOptions("msedge").channel === "msedge", "a Playwright channel name passes through");
  expect(browserLaunchOptions(process.execPath).executablePath === process.execPath, "a path becomes the executable to launch");
  expect((await errOf(Promise.resolve().then(() => browserLaunchOptions("/no/such/browser")))).includes("No browser at"), "a missing path is named");
  const brave = await errOf(Promise.resolve().then(() => browserLaunchOptions("brave")));
  expect(brave === "" || brave.includes("usual install location"), `brave is found where it's installed, or the error says to pass a path: ${brave || "found"}`);

  // --- readiness: late data, and a ready selector for a slow shell ---
  process.env.WITNESS_IGNORE_ERRORS = "appinsights|favicon\\.ico";
  const s1 = new BrowserSession(dir());
  const first = await s1.start(url);
  expect(first.aria.includes("Dashboard: 3 projects"), "the first snapshot waits for the app's data to load");
  expect(!first.aria.includes("Menu loaded"), "without a ready selector, a timer-only render isn't waited for");

  // --- known-noise errors ---
  expect(first.consoleErrors.length === 0, `telemetry noise is left out of the evidence: ${first.consoleErrors.join(" | ") || "none"}`);
  const save = await s1.act("click", {}, (p) => p.getByRole("button", { name: "Save" }).click());
  expect(save.consoleErrors.some((e) => e.includes("real bug")), "a real error is still recorded");
  const ignored = s1.ignoredErrors();
  expect(ignored.length === 1 && ignored[0].count >= 1 && ignored[0].example.includes("appinsights"), `ignored errors are counted: ${JSON.stringify(ignored.map((e) => [e.pattern, e.count]))}`);
  await s1.stop();
  delete process.env.WITNESS_IGNORE_ERRORS;

  process.env.WITNESS_READY_SELECTOR = "#ready";
  const s2 = new BrowserSession(dir());
  const ready = await s2.start(url);
  expect(ready.aria.includes("Menu loaded"), "with WITNESS_READY_SELECTOR, the first snapshot waits for the shell");
  await s2.stop();
  process.env.WITNESS_READY_SELECTOR = "#never";
  process.env.WITNESS_READY_TIMEOUT_MS = "800";
  const s3 = new BrowserSession(dir());
  const late = await s3.start(url);
  expect(late.result.includes("did not appear"), `a selector that never shows is noted, not fatal: ${late.result}`);
  await s3.stop();
  delete process.env.WITNESS_READY_SELECTOR;
  delete process.env.WITNESS_READY_TIMEOUT_MS;

  const rulesDir = dir();
  writeFileSync(join(rulesDir, "rules.txt"), "# noise\nfavicon.ico\n/^console\\.error: ResizeObserver/i\n");
  const rules = loadIgnoreRules(join(rulesDir, "rules.txt"));
  expect(
    rules.length === 2 && rules[0].test("GET /favicon.ico -> 404") && rules[1].test("console.error: resizeobserver loop") && !rules[1].test("uncaught: ResizeObserver"),
    "ignore file: substrings and /regex/flags, comments skipped",
  );

  // --- saved logins: expiry, sessionStorage, the sign-in site ---
  const work = dir();
  process.chdir(work);
  mkdirSync(".witness");
  const now = Date.now() / 1000;
  const state = (expires: number) => ({ cookies: [{ name: "sid", value: "x", domain: "127.0.0.1", path: "/", expires, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] });
  writeFileSync(AUTH_FILE, JSON.stringify(state(now - 3600)));
  const w = authWarnings(AUTH_FILE);
  expect(w.length === 1 && w[0].includes("expired") && w[0].includes("sid"), `expired cookies are flagged: ${w[0]?.slice(0, 80)}`);
  writeFileSync(AUTH_FILE, JSON.stringify(state(now + 3600)));
  expect(authWarnings(AUTH_FILE).length === 0, "a fresh login has no warning");

  // Without --manual's extra file: the sign-in site is blocked, nothing restored.
  const plain = new BrowserSession(dir(), { storageState: AUTH_FILE });
  const p1 = await plain.start(url);
  expect(p1.aria.includes("token=none"), "no sessionStorage without a manual sign-in");
  expect((await errOf(plain.goto(`${idpUrl}/login`))).includes("Blocked"), "the sign-in site is blocked by default");
  await plain.stop();

  writeFileSync(
    AUTH_EXTRA_FILE,
    JSON.stringify({ savedAt: new Date().toISOString(), appOrigin: new URL(url).origin, signInOrigins: [idpUrl], sessionStorage: { token: "abc123" } }),
  );
  process.env.WITNESS_SECRET_PW = "hunter2-value";
  resetSecrets();
  const signed = new BrowserSession(dir(), { storageState: AUTH_FILE });
  const p2 = await signed.start(url);
  expect(p2.aria.includes("token=abc123"), "sessionStorage from the manual sign-in is restored");
  await signed.fill(signed.page.getByLabel("Password"), "{{secret:PW}}");
  expect((await signed.page.getByLabel("Password").inputValue()) === "hunter2-value", "secrets are still typed on the app");
  await signed.goto(`${idpUrl}/login`);
  expect(signed.page.url().startsWith(idpUrl), "the sign-in site seen during sign-in may load");
  const idpErr = await errOf(signed.fill(signed.page.getByLabel("IdP password"), "{{secret:PW}}"));
  expect(idpErr.includes("Refused to type a secret"), "but secrets are never typed on it");
  await signed.stop();
  delete process.env.WITNESS_SECRET_PW;
} finally {
  process.chdir(cwd);
  process.env.PATH = path;
  app.close();
  idp.close();
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
