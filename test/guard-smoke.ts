// No-LLM test of the browsing guard: the Driver can't leave the app's origin
// (other sites, local files), links off-site are blocked, and secrets are only
// typed into fields on allowed origins.
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BrowserSession } from "../src/browser.ts";
import { resetSecrets } from "../src/secrets.ts";
import { runTool } from "../src/tools.ts";

const listen = async (html: string) => {
  const srv = http.createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/` };
};

const other = await listen(`<!doctype html><title>Other</title><h1>Other site</h1>`);
const app = await listen(`<!doctype html><title>App</title><h1>App</h1>
<a href="${other.url}">Leave</a>
<label>Name <input id="name"></label>
<iframe title="Embedded" src="data:text/html,<label>Evil <input></label>"></iframe>`);

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const refOf = (snap: string, re: RegExp) => snap.split("\n").find((l) => re.test(l))?.match(/\[ref=(f?\d*e\d+)\]/)?.[1];
const dirs: string[] = [];
const session = async () => {
  const d = await mkdtemp(join(tmpdir(), "witness-guard-"));
  dirs.push(d);
  const s = new BrowserSession(d);
  await s.start(app.url);
  return { s, d };
};

process.env.WITNESS_SECRET_TOKEN = "tok-very-secret-123";
resetSecrets();

try {
  const { s, d } = await session();
  const file = await runTool(s, d, "navigate", { url: "file:///etc/hosts" });
  expect(file.isError && s.page.url() === app.url, `file:// is blocked: ${file.text?.split("\n")[0]}`);

  const off = await runTool(s, d, "navigate", { url: other.url });
  expect(off.isError && s.page.url() === app.url && /outside the app/.test(off.text ?? ""), "another origin is blocked");

  const rel = await runTool(s, d, "navigate", { url: "/?page=2" });
  expect(!rel.isError && s.page.url() === `${app.url}?page=2`, "a relative URL on the app still works");

  let snap = await s.snapshot();
  await runTool(s, d, "click", { ref: refOf(snap, /link "Leave"/), element: "Leave" });
  expect(new URL(s.page.url()).origin === new URL(app.url).origin, `clicking an off-site link doesn't leave the app (still ${s.page.url()})`);

  snap = await s.snapshot();
  const ok = await runTool(s, d, "type", { ref: refOf(snap, /textbox "Name"/), text: "{{secret:TOKEN}}", submit: false });
  expect(!ok.isError && (await s.page.locator("#name").inputValue()) === "tok-very-secret-123", "a secret is typed into the app's own field");

  const evilRef = refOf(snap, /textbox "Evil"/);
  const evil = evilRef ? await runTool(s, d, "type", { ref: evilRef, text: "{{secret:TOKEN}}", submit: false }) : undefined;
  const leaked = await s.page.frames()[1]?.locator("input").inputValue().catch(() => "");
  expect(!!evil?.isError && leaked !== "tok-very-secret-123", `a secret is refused in a field from another origin: ${evil?.text?.split("\n")[0] ?? "(frame field not found)"}`);
  await s.stop();

  process.env.WITNESS_ALLOWED_ORIGINS = other.url;
  const { s: s2, d: d2 } = await session();
  const allowed = await runTool(s2, d2, "navigate", { url: other.url });
  expect(!allowed.isError && s2.page.url() === other.url, "WITNESS_ALLOWED_ORIGINS lets the Driver open a listed origin");
  await s2.stop();
} finally {
  delete process.env.WITNESS_ALLOWED_ORIGINS;
  app.srv.close();
  other.srv.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
