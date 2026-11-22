// Serves the Driver's browser tools over MCP (streamable HTTP on localhost),
// inside the Witness process, so the BrowserSession and its evidence stay
// here while an external agent such as Claude Code does the driving.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BrowserSession } from "./browser.js";
import { TOOL_SPECS, runTool, type FinishInput, type ToolName } from "./tools.js";

interface ToolServerOptions {
  log?: (line: string) => void;
  onFinish: (f: FinishInput) => void;
  /** After this many browser actions, tools refuse and ask the agent to finish. */
  maxActions?: number;
}

export async function startToolServer(session: BrowserSession, runDir: string, opts: ToolServerOptions) {
  const maxActions = opts.maxActions ?? 60;
  let actions = 0;
  // Browser actions run one at a time even if the agent calls tools in parallel.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  const buildServer = () => {
    const server = new McpServer({ name: "witness", version: "0.1.0" });
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      server.registerTool(name, { description: spec.description, inputSchema: spec.shape }, (input: unknown) =>
        serial(async () => {
          if (name !== "finish" && name !== "snapshot" && ++actions > maxActions) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "Step limit reached. Call finish now with what you observed." }],
            };
          }
          const out = await runTool(session, runDir, name as ToolName, input, opts.log);
          if (out.finish) opts.onFinish(out.finish);
          return {
            isError: out.isError,
            content: out.imageBase64
              ? [{ type: "image" as const, data: out.imageBase64, mimeType: "image/png" }]
              : [{ type: "text" as const, text: out.text ?? "" }],
          };
        }),
      );
    }
    return server;
  };

  // Stateless mode: a fresh MCP server + transport per request, all sharing
  // the one browser session through the closures above.
  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}
