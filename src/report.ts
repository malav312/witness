// Writes the evidence bundle: report.json (machine) and report.html (human).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepRecord } from "./browser.js";
import type { DriverResult } from "./driver.js";
import type { Verdict } from "./judge.js";

export interface RunReport {
  id: string;
  goal: string;
  url: string;
  model: string;
  backend: string;
  startedAt: string;
  durationMs: number;
  driver: { status: DriverResult["status"]; summary: string };
  verdict: Verdict;
  steps: StepRecord[];
  consoleErrors: string[];
  failedRequests: string[];
  usage: { input: number; output: number };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const COLORS = { pass: "#1a7f37", fail: "#cf222e", inconclusive: "#9a6700" };

export async function writeReport(runDir: string, report: RunReport) {
  // The JSON report omits per-step snapshots; they're bulky and live in the trace.
  const slim = { ...report, steps: report.steps.map(({ snapshot: _snapshot, aria: _aria, ...s }) => s) };
  await writeFile(join(runDir, "report.json"), JSON.stringify(slim, null, 2));
  await writeFile(join(runDir, "report.html"), html(report));
}

function html(r: RunReport): string {
  const v = r.verdict;
  const criteria = v.criteria
    .map(
      (c) => `<tr class="${c.status}">
        <td>${c.status === "met" ? "✓" : c.status === "not_met" ? "✗" : "–"}</td>
        <td>${esc(c.criterion)}<div class="note">${esc(c.note)}</div></td>
        <td>${c.evidence_steps.map((n) => `<a href="#step-${n}">#${n}</a>`).join(" ")}</td>
      </tr>`,
    )
    .join("");
  const steps = r.steps
    .map(
      (s) => `<figure id="step-${s.index}" class="${s.ok ? "" : "err"}">
        <a href="${esc(s.screenshot)}"><img src="${esc(s.screenshot)}" loading="lazy" alt="after step ${s.index}"></a>
        <figcaption><b>#${s.index} ${esc(s.action)}</b> ${esc(s.result)}
        ${s.consoleErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join("")}
        ${s.failedRequests.map((e) => `<div class="bad">${esc(e)}</div>`).join("")}</figcaption>
      </figure>`,
    )
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Witness: ${esc(v.verdict)} · ${esc(r.goal)}</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#1f2328}
.verdict{display:inline-block;padding:4px 12px;border-radius:6px;color:#fff;font-weight:600;text-transform:uppercase;background:${COLORS[v.verdict]}}
h1{font-size:20px;margin:12px 0 4px} .meta{color:#656d76}
table{border-collapse:collapse;width:100%;margin:16px 0} td{padding:8px;border-top:1px solid #d0d7de;vertical-align:top}
tr.met td:first-child{color:${COLORS.pass}} tr.not_met td:first-child{color:${COLORS.fail}} tr.not_tested td:first-child{color:${COLORS.inconclusive}}
.note{color:#656d76;font-size:13px} .bad{color:${COLORS.fail};font-family:ui-monospace,monospace;font-size:12px}
.claim{background:#f6f8fa;border-left:3px solid #d0d7de;padding:8px 12px;color:#656d76}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
figure{margin:0;border:1px solid #d0d7de;border-radius:6px;overflow:hidden} figure.err{border-color:${COLORS.fail}}
figure img{width:100%;display:block;border-bottom:1px solid #d0d7de} figcaption{padding:6px 8px;font-size:12px}
</style></head><body>
<span class="verdict">${esc(v.verdict)}</span>
<h1>${esc(r.goal)}</h1>
<div class="meta">${esc(r.url)} · ${r.steps.length} steps · ${(r.durationMs / 1000).toFixed(1)}s · ${esc(r.backend)} (${esc(r.model)}) · ${r.usage.input + r.usage.output} tokens</div>
<p>${esc(v.summary)}</p>
<table>${criteria}</table>
${v.problems.length ? `<h2>Problems observed</h2><ul>${v.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
<h2>What the agent said</h2>
<div class="claim">${esc(r.driver.summary)}<br><small>Driver status: ${esc(r.driver.status)}. Not used by the judge.</small></div>
<h2>Evidence</h2>
<div class="grid">${steps}</div>
<p class="meta">Full replay: <code>npx playwright show-trace trace.zip</code></p>
</body></html>`;
}
