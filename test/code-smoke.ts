// No-LLM test of the code scan and of how it joins the map: what the source
// says is found, the crawl decides what was really seen, and citations the
// model makes up don't survive.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { matchesRoute, routeControls, scanCode, seedPaths } from "../src/code.ts";
import { checkMap, codeContext, codeMatchesApp, codeSection, crawl, labelScenarios, readMap, writeMap, type FeatureMap, type Seeds } from "../src/map.ts";

let failed = 0;
const expect = (ok: boolean, msg: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};
const root = mkdtempSync(join(tmpdir(), "witness-code-"));
const put = (repo: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, repo, file)), { recursive: true });
  writeFileSync(join(root, repo, file), text);
};

// ---------- a React app with an Express API ----------
put("react", "package.json", JSON.stringify({ dependencies: {}, imports: { "#ui/*": "./src/ui/*.tsx" } }));
put("react", "src/App.tsx", `
import { lazy } from "react";
import { Routes, Route } from "react-router";
import Invoices from "./Invoices";
import { Reports } from "@/reports";
const Team = lazy(() => import("./Team"));
export const App = () => (
  <Routes>
    <Route path="/" element={<Shell />}>
      <Route path="invoices" element={<Guard><Invoices /></Guard>} />
      <Route path="invoices/:id" element={<Invoices />} />
      <Route path="logout" element={<Invoices />} />
    </Route>
    <Route path="/team" element={<Team />} />
    <Route path="/reports/*" element={<Reports />} />
    <Route path="*" element={<NotFound />} />
  </Routes>
);`);
put("react", "src/Invoices.tsx", `
import { Amount } from "#ui/Amount";
export default function Invoices({ t }) {
  return <form>
    <label htmlFor="po">PO number</label><input id="po" required maxLength={12} />
    <input type="hidden" name="csrf" /><Amount />
    <select aria-label="Approver" required={needsApproval}><option>Ann</option></select>
    <button type="submit">{t("Submit for approval")}</button>
  </form>;
}`);
put("react", "src/ui/Amount.tsx", `export const Amount = () => <TextField label="Amount" min={0} />;`);
put("react", "src/Team.tsx", `export default () => <p>it's a team</p>;`);
put("react", "src/reports/index.ts", `export { Reports } from "./Router";`);
put("react", "src/reports/Router.tsx", `import { Routes, Route } from "react-router"; export const Reports = () => <Routes><Route path="/cash" element={<Cash />} /></Routes>;`);
put("react", "src/types.ts", `
export type InvoiceStatus = "draft" | "submitted" | "approved" | "paid";
export enum Role { Clerk = "clerk", Manager = "manager" }
export type Size = "s" | "m";
const cast = <string>value;`);
put("react", "server/index.ts", `
import express from "express"; import invoices from "./invoices.js";
const app = express(); app.use("/api/invoices", invoices);
app.get("/health", (req, res) => res.end());`);
put("react", "server/invoices.ts", `
import { Router } from "express"; const router = Router();
router.get("/", list); router.post("/:id/approve", requireManager, async (req, res) => {});
export default router;`);
put("react", "src/client.ts", `api.get("/not-an-endpoint", { headers }); app.get("/also-not", { config: 1 });`);
put("react", "src/menu.ts", `export const menu = [{ path: "/not-a-route", label: "Docs" }];`);
put("react", "e2e/invoice.test.tsx", `test("a manager approves an invoice", async () => {}); const r = <Route path="/in-a-test" element={<X />} />;`);
put("react", "src/broken.tsx", `export const = <<<`);
writeFileSync(join(root, "outside.tsx"), `const X = () => <Route path="/outside" element={<Y />} />;`);
symlinkSync(join(root, "outside.tsx"), join(root, "react/src/link.tsx"));
put("react", ".gitignore", "generated/\n");
put("react", "generated/gen.tsx", `const X = () => <Route path="/ignored" element={<Y />} />;`);
execFileSync("git", ["init", "-q"], { cwd: join(root, "react") });

// ---------- a Vue app with socket.io ----------
put("vue", "package.json", JSON.stringify({ dependencies: { "socket.io": "4" } }));
put("vue", "src/router.js", `
import Layout from "./Layout.vue"; import Edit from "./Edit.vue";
const Settings = () => import("./Settings.vue");
const routes = [
  { path: "/", component: Layout, children: [
    { path: "settings", component: Settings, children: [{ path: "general", component: Edit }] },
    { path: "/edit/:id", component: Edit },
  ] },
  { path: "/old", redirect: "/settings" },
  { path: "/:pathMatch(.*)*", component: Layout },
];`);
put("vue", "src/Edit.vue", `<template>
  <!-- <input id="commented"> -->
  <label for="phone">{{ $t("Phone number") }}</label>
  <input
    id="phone" :required="true" minlength="3" :maxlength="max > 5 ? 20 : 15" />
  <button @click="a > b ? save() : null">{{ $t("Save") }}</button>
</template>
<script setup lang="ts">
const x = <string>y;
</script>`);
put("vue", "src/Layout.vue", `<template><div/></template>`);
put("vue", "src/Settings.vue", `<template><div/></template>`);
put("vue", "server/server.js", `io.on("connection", (socket) => { socket.on("addMonitor", async (m, cb) => {}); socket.on("disconnect", () => {}); });`);
put("vue", "src/socket.js", `import { io } from "socket.io-client"; const socket = io(); socket.on("monitorList", () => {});`);

try {
  const r = scanCode(join(root, "react"));
  const paths = r.routes.map((x) => x.path).join(" ");
  expect(paths === "/ /invoices /invoices/:id /logout /reports /reports/cash /team", `React routes, nested and under /reports/*: ${paths}`);
  const inv = routeControls(r, r.routes.find((x) => x.path === "/invoices")!);
  const show = (c: (typeof inv)[number]) => `${c.control}{${c.rules.join(",")}}`;
  expect(
    inv.map(show).sort().join(" ") === 'button "Submit for approval"{} combobox "Approver"{required when needsApproval} textbox "Amount"{min=0} textbox "PO number"{required,maxlength=12}',
    `form controls with rules, through an import alias: ${inv.map(show).join(" ")}`,
  );
  const eps = r.endpoints.map((e) => `${e.method} ${e.path}`).sort().join(", ");
  expect(eps === "GET /api/invoices, GET /health, POST /api/invoices/:id/approve", `endpoints, with the mount prefix: ${eps}`);
  expect(r.states.map((s) => s.name).sort().join() === "InvoiceStatus,Role", `status and role values: ${r.states.map((s) => `${s.name}=${s.values}`).join(" ")}`);
  expect(r.tests.length === 1 && r.tests[0].title === "a manager approves an invoice", "end-to-end test titles");
  expect(r.unparsed.includes("src/broken.tsx"), `a file that doesn't parse is reported, not fatal: ${r.unparsed}`);
  expect(r.unparsed.includes("src/link.tsx") && !paths.includes("outside"), "a symlink out of the repo isn't followed");
  expect(!paths.includes("ignored"), "git-ignored files are skipped");
  const seeds = seedPaths(r);
  expect(seeds.open.join() === "/,/invoices,/reports,/reports/cash,/team" && seeds.skipped.join() === "/logout", `routes to open: ${seeds.open}; never opened: ${seeds.skipped}`);

  put("react", "src/big.ts", Array.from({ length: 3000 }, (_, i) => `export type Big${i}Status = "a${i}" | "b${i}";`).join("\n"));
  const json = execFileSync("sh", ["-c", `node bin/witness.js scan "${join(root, "react")}" --json | cat`], { encoding: "utf8", maxBuffer: 1e8 });
  expect(json.length > 100_000 && JSON.parse(json).states.length > 3000, `witness scan --json isn't cut off in a pipe (${json.length} bytes)`);
  rmSync(join(root, "react/src/big.ts"));

  const v = scanCode(join(root, "vue"));
  const vpaths = v.routes.map((x) => x.path).join(" ");
  expect(vpaths === "/ /edit/:id /settings /settings/general", `Vue routes, without redirects and catch-alls: ${vpaths}`);
  const edit = v.controls.map((c) => `${c.control}{${c.rules.join(",")}}:${c.line}`).join(" ");
  expect(edit === 'textbox "Phone number"{required,maxlength when max > 5 ? 20 : 15,minlength=3}:4 button "Save"{}:6', `Vue template controls: ${edit}`);
  expect(v.endpoints.map((e) => `${e.method} ${e.path}`).join() === "SOCKET addMonitor", `socket events the server handles, not the client's: ${v.endpoints.map((e) => e.path)}`);

  expect(matchesRoute("/status/:slug", "/status/main?x=1") && matchesRoute("/a/:id?", "/a") && !matchesRoute("/status/:slug", "/status") && !matchesRoute("/a", "/a/b"), "concrete paths match route patterns");

  // ---------- the crawl decides what was seen ----------
  const login = "<h1>Sign in</h1><input type=password aria-label=Password>";
  const pagesHtml: Record<string, string> = {
    "/": '<h1>Home</h1><a href="/invoices">Invoices</a>',
    "/invoices": '<h1>Invoices</h1><button>Submit for approval</button>',
    "/team": "<h1>Team</h1><button>Invite</button>",
    "/locked": login,
    "/reports": login,
  };
  let loggedOut = false;
  const server = http.createServer((req, res) => {
    const p = req.url ?? "/";
    if (p === "/logout") loggedOut = true;
    if (p === "/reports/cash") return res.writeHead(302, { location: "/invoices" }).end();
    res.writeHead(p in pagesHtml ? 200 : 404, { "content-type": "text/html" }).end(pagesHtml[p] ?? "nope");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const out = join(root, "crawl");
  const s: Seeds = { paths: ["/", "/invoices", "/team", "/locked", "/reports", "/reports/cash", "/gone"], notes: {} };
  const pages = await crawl(url, out, 20, undefined, s);
  expect(pages.map((p) => `${p.path}${p.fromCode ? "*" : ""}`).join() === "/,/invoices,/team*,/locked*", `unlinked routes are opened too: ${pages.map((p) => p.path)}`);
  expect(s.notes["/reports"]?.includes("same page as /locked") && s.notes["/reports/cash"] === "redirects to /invoices" && s.notes["/gone"] === "HTTP 404", `and the ones that don't count say why: ${JSON.stringify(s.notes)}`);
  expect(!loggedOut, "/logout was never opened");

  const section = codeSection(r, ".", pages, s.notes);
  const trust = (p: string) => section.routes.find((x) => x.path === p)?.trust;
  expect(trust("/team") === "seen in app" && trust("/reports") === "from code" && trust("/invoices/:id") === "from code", "routes are labeled by what the crawl saw");
  expect(codeMatchesApp(r, pages) && !codeMatchesApp(v, pages), "another project's code is recognized as not this app's");

  // ---------- the model's citations are checked ----------
  const ctx = codeContext(r);
  const id = [...ctx.refs].find(([k, f]) => k.startsWith("C") && f.startsWith("src/Invoices.tsx"))![0];
  const scenario = (name: string, pgs: string[], controls: string[], code: string[]) => ({ name, needs: [], pages: pgs, steps: [], controls, expected: [], code });
  const { scenarios, dropped } = labelScenarios(
    [
      scenario("Seen", ["/invoices"], ['button "Submit for approval"'], [id]),
      scenario("Form field not in the crawl", ["/invoices"], ['textbox "PO number"'], [id, "C999"]),
      scenario("Page not in the crawl", ["/reports/cash"], ['button "Submit for approval"'], [id]),
      scenario("No controls", ["/invoices"], [], [id]),
      scenario("Made up", ["/teleport"], ['button "Teleport"'], ["C999", "R0"]),
    ],
    ctx,
    pages,
  );
  expect(scenarios.map((x) => x.trust).join() === "seen in app,from code,from code,from code", `trust comes from matching: ${scenarios.map((x) => `${x.name}=${x.trust}`).join("; ")}`);
  expect(scenarios[1].code.length === 1 && scenarios[1].code[0].startsWith("src/Invoices.tsx:"), "a made-up citation is removed");
  expect(dropped.join() === "Made up", "a scenario with nothing behind it is dropped");

  // ---------- the map file ----------
  const file = join(root, "witness.map.yaml");
  const many = Array.from({ length: 300 }, (_, i) => `option "Zone ${i}"`);
  const map: FeatureMap = {
    generated: "", url, summary: "", features: [], scenarios, code: { ...section, dir: join(root, "react") },
    pages: pages.map((p) => ({ path: p.path, title: "", purpose: "", controls: p.path === "/team" ? [...p.controls, ...many] : p.controls, ...(p.fromCode ? { fromCode: true as const } : {}) })),
  };
  await writeMap(map, file);
  const read = (await readMap(file))!;
  expect(read.map.code!.routes.length === r.routes.length && read.map.pages.some((p) => p.controls.length > 300), "the saved map keeps everything");
  expect(!read.text.includes("/api/invoices") && !read.text.includes("src/Invoices.tsx") && read.text.includes("trust: from code"), "the Driver's copy has the labels but no endpoints or file names");
  expect(read.text.includes("and 290 more options") && !read.text.includes("Zone 200"), "and long option lists are shortened");

  map.pages.forEach((p) => (p.controls = p.controls.filter((c) => !c.startsWith("option"))));
  const none = await checkMap(map, url, out);
  expect(none.addedPages.length + none.removedPages.length + none.addedRoutes.length + none.removedRoutes.length === 0, `check finds no drift: ${JSON.stringify(none)}`);
  put("react", "src/New.tsx", `const X = () => <Route path="/refunds" element={<Y />} />;`);
  expect((await checkMap(map, url, out)).addedRoutes.join() === "/refunds", "check reports a route new in the code");
  server.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
