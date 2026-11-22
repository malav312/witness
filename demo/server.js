// Witness demo target: a tiny todo app with bugs you can switch on.
//
//   node demo/server.js                          # clean app
//   WITNESS_BUGS=no-persist,dead-add node demo/server.js
//
// Each bug is a realistic regression an agent might ship and claim "works".
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const BUGS = {
  "no-persist": "Todos are not saved, so they vanish on reload",
  "dead-add": "Clicking the Add button does nothing (Enter still works)",
  "count-off": "The 'items left' counter is off by one",
  "delete-wrong": "Deleting a todo removes the one below it",
  "empty-allowed": "Blank todos can be added",
  "toggle-noop": "Checking a todo does not mark it done",
  "clear-all": "'Clear completed' removes every todo, not just completed ones",
  "console-error": "Adding a todo throws an uncaught error in the console",
  // Not a bug: a harmless UI change. Replays diverge; --heal should re-verify,
  // find the goal still holds, and re-record.
  "new-heading": "(not a bug) The heading is renamed to 'My tasks'",
};

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const enabled = (process.env.WITNESS_BUGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const bug of enabled) {
  if (!(bug in BUGS)) {
    console.error(`Unknown bug "${bug}". Known: ${Object.keys(BUGS).join(", ")}`);
    process.exit(1);
  }
}

const html = readFileSync(join(here, "index.html"), "utf8").replace(
  "/*__BUGS__*/",
  `window.__BUGS = ${JSON.stringify(enabled)};`,
);

http
  .createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else {
      res.writeHead(404).end("not found");
    }
  })
  .listen(port, () => {
    console.log(`demo app on http://localhost:${port}  bugs: ${enabled.join(", ") || "none"}`);
  });
