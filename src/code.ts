// The code scan: what the source says the app has. Deterministic, local, no
// model. It finds what a crawl can't reach (unlinked routes, forms behind
// buttons, endpoints, status values), but it only shows what the code is meant
// to do, so everything here is a hypothesis until it's seen in the running app.
//
//   routes     React Router (<Route> and route objects) and Vue Router
//   controls   form fields and buttons in JSX, Vue templates and HTML, with
//              their validation rules (required, maxlength...)
//   endpoints  Express-style HTTP handlers and socket.io events
//   states     enums and unions that look like statuses, roles or types
//   tests      titles of existing end-to-end tests
import { parse, type ParserPlugin } from "@babel/parser";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";

export interface CodeRoute {
  path: string;
  file: string;
  line: number;
  /** Files of the components the route renders. */
  components: string[];
  /** A nested route whose parent wasn't found, so `path` isn't the full path. */
  partial?: boolean;
}
export interface CodeControl {
  control: string; // e.g. textbox "Phone number"
  rules: string[]; // e.g. required, maxlength=15
  file: string;
  line: number;
}
export interface CodeEndpoint {
  method: string; // GET, POST... or SOCKET
  path: string;
  file: string;
  line: number;
}
export interface CodeState {
  name: string;
  values: string[];
  file: string;
  line: number;
}
export interface CodeTest {
  title: string;
  file: string;
  line: number;
}
export interface CodeScan {
  files: number;
  /** Files that couldn't be read or parsed, so their contents are missing here. */
  unparsed: string[];
  hashRouting: boolean;
  routes: CodeRoute[];
  controls: CodeControl[];
  endpoints: CodeEndpoint[];
  states: CodeState[];
  tests: CodeTest[];
  /** Local files each file imports. */
  imports: Record<string, string[]>;
}

const SOURCE = /\.(m?[jt]sx?|cjs|cts|vue|html)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|public|__tests__|__mocks__|tests?|e2e|cypress|playwright|\.storybook)\/|\.(test|spec|stories|d|min)\.[a-z]+$/i;
const E2E = /(^|\/)(e2e|cypress|playwright)\/.*\.[jt]sx?$|\.e2e\.[jt]sx?$/i;
const MAX_BYTES = 400_000;

// ---------- files ----------

function listFiles(root: string): string[] {
  try {
    // Tracked files plus new ones that aren't ignored.
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return [...new Set(out.split("\0").filter(Boolean))].sort();
  } catch {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        const p = posix.join(dir, e.name);
        if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
        else if (e.isFile()) files.push(p);
      }
    };
    walk("");
    return files.sort();
  }
}

// ---------- parsing ----------

type Node = any;

function parseCode(code: string, file: string): Node {
  const ext = extname(file).toLowerCase();
  const ts = /^\.[mc]?tsx?$/.test(ext);
  const plugins: ParserPlugin[] = ["decorators"];
  if (ts) plugins.push("typescript");
  if (!ts || ext === ".tsx") plugins.push("jsx"); // in plain .ts, <T>x is a type assertion
  return parse(code, { sourceType: "unambiguous", errorRecovery: true, allowReturnOutsideFunction: true, plugins });
}

const isNode = (n: unknown): n is Node => !!n && typeof (n as Node).type === "string";

function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const key in n) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "errors") continue;
    const v = n[key];
    if (Array.isArray(v)) out.push(...v.filter(isNode));
    else if (isNode(v)) out.push(v);
  }
  return out;
}

/** Depth-first. Return false from `fn` to skip a node's children. */
function walk(n: Node, fn: (n: Node) => boolean | void) {
  if (fn(n) === false) return;
  for (const c of children(n)) walk(c, fn);
}

function str(n: Node): string | undefined {
  if (!n) return;
  if (n.type === "StringLiteral") return n.value;
  if (n.type === "TemplateLiteral" && !n.expressions.length) return n.quasis[0].value.cooked;
  if (n.type === "JSXExpressionContainer") return str(n.expression);
  if (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression") return str(n.expression);
}

const keyName = (p: Node): string | undefined =>
  p.computed ? undefined : p.key?.type === "Identifier" ? p.key.name : str(p.key);
const prop = (obj: Node, name: string): Node => obj.properties.find((p: Node) => (p.type === "ObjectProperty" || p.type === "ObjectMethod") && keyName(p) === name);
const lineOf = (n: Node, offset: number): number => (n.loc?.start.line ?? 1) + offset;

/** Local files imported for a given name or module, resolved later. */
interface FileInfo {
  file: string;
  specs: Set<string>;
  names: Map<string, string>; // local name -> module specifier
  routes: { path: string; line: number; names: string[]; specs: string[]; partial: boolean; splat: boolean; top: boolean }[];
  mounts: { prefix: string; name: string }[];
  endpoints: { router: string; method: string; path: string; line: number }[];
}

function importSource(n: Node): string | undefined {
  if (n.type === "ImportExpression") return str(n.source);
  if (n.type === "CallExpression" && (n.callee.type === "Import" || (n.callee.type === "Identifier" && n.callee.name === "require"))) return str(n.arguments[0]);
}

function collectImports(ast: Node, info: FileInfo) {
  walk(ast, (n) => {
    if (n.type === "ImportDeclaration") {
      info.specs.add(n.source.value);
      for (const s of n.specifiers) info.names.set(s.local.name, n.source.value);
    } else if ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source) {
      info.specs.add(n.source.value);
    } else if (n.type === "VariableDeclarator" && n.init) {
      // const X = require("./x"), () => import("./x"), lazy(() => import("./x"))
      let src: string | undefined;
      walk(n.init, (c) => {
        if (src || /Declaration$|^Class/.test(c.type)) return false;
        src = importSource(c);
      });
      if (src && n.id.type === "Identifier") info.names.set(n.id.name, src);
      if (src && n.id.type === "ObjectPattern") for (const p of n.id.properties) if (p.value?.type === "Identifier") info.names.set(p.value.name, src);
    }
    const src = importSource(n);
    if (src) info.specs.add(src);
  });
}

// ---------- routes ----------

function joinRoute(parent: string | undefined, path: string): { path: string; partial: boolean } {
  if (path.startsWith("/")) return { path, partial: false };
  if (parent === undefined) return { path, partial: true };
  const base = parent.replace(/\/?\*$/, "").replace(/\/$/, "");
  return { path: path ? `${base}/${path}` : base || "/", partial: !base.startsWith("/") && base !== "" };
}

const ROUTE_KEYS = ["component", "components", "Component", "element", "lazy", "redirect"];

function collectRoutes(ast: Node, info: FileInfo, offset: number) {
  const add = (parent: string | undefined, path: string, line: number, value: Node | undefined, jsx = false) => {
    const full = joinRoute(parent, path);
    const names: string[] = [];
    const specs: string[] = [];
    if (value) {
      walk(value, (n) => {
        if (n.type === "JSXIdentifier" && /^[A-Z]/.test(n.name)) names.push(n.name);
        else if (n.type === "Identifier") names.push(n.name);
        const src = importSource(n);
        if (src) specs.push(src);
      });
    }
    const splat = /\*$/.test(full.path) && !full.path.includes("(");
    const clean = splat ? full.path.replace(/\/?\*$/, "") : full.path;
    // A catch-all ("*", "/:pathMatch(.*)*") is a not-found page, not a route to visit.
    if ((splat && !clean) || full.path.includes("(")) return full.path;
    info.routes.push({ path: clean || "/", line, names: [...new Set(names)], specs, partial: full.partial, splat, top: jsx && parent === undefined });
    return full.path;
  };

  const visit = (n: Node, parent: string | undefined): void => {
    if (n.type === "ObjectExpression") {
      const p = prop(n, "path");
      const path = p && p.type === "ObjectProperty" ? str(p.value) : undefined;
      const kids = prop(n, "children");
      const isRoute = ROUTE_KEYS.some((k) => prop(n, k)) || kids?.value?.type === "ArrayExpression";
      if ((path !== undefined || prop(n, "index")) && isRoute) {
        const view = ["component", "components", "Component", "element", "lazy"].map((k) => prop(n, k)).find(Boolean);
        const redirect = prop(n, "redirect");
        const own = path ?? "";
        const full = view && !redirect ? add(parent, own, lineOf(n, offset), view.value ?? view) : joinRoute(parent, own).path;
        for (const c of n.properties) {
          if (c === kids) visit(kids.value, full);
          else if (c !== view) visit(c, undefined);
        }
        return;
      }
      // A pathless layout route passes its parent's path through.
      if (kids?.value?.type === "ArrayExpression" && parent !== undefined) return visit(kids.value, parent);
    }
    if (n.type === "ArrayExpression") return void n.elements.filter(isNode).forEach((e: Node) => visit(e, parent));
    if (n.type === "JSXElement" && n.openingElement.name.name === "Route") {
      const attr = (name: string) => n.openingElement.attributes.find((a: Node) => a.type === "JSXAttribute" && a.name.name === name);
      const pathAttr = attr("path");
      const path = pathAttr ? str(pathAttr.value) : undefined;
      const view = attr("element") ?? attr("component") ?? attr("Component") ?? attr("render");
      let full = parent;
      if (path !== undefined || attr("index")) {
        full = view || n.children.some((c: Node) => c.type === "JSXElement" && c.openingElement.name.name !== "Route")
          ? add(parent, path ?? "", lineOf(n, offset), view?.value ?? undefined, true)
          : joinRoute(parent, path ?? "").path;
      }
      for (const c of n.children) visit(c, full);
      return;
    }
    const keep = n.type === "JSXElement" || n.type === "JSXFragment" || n.type === "JSXExpressionContainer" || n.type === "LogicalExpression" || n.type === "ConditionalExpression";
    for (const c of children(n)) visit(c, keep ? parent : undefined);
  };
  visit(ast, undefined);
}

// ---------- endpoints ----------

const HTTP = new Set(["get", "post", "put", "patch", "delete", "all"]);
const ROUTER = /^(app|server|router|\w*(Router|App))$/;
// Connection plumbing on raw sockets, not app events.
const SOCKET_BUILTIN = new Set("connect connection connecting disconnect disconnecting error connect_error message close data end open listening ready timeout drain upgrade packet ping pong reconnect".split(" "));

function collectEndpoints(ast: Node, info: FileInfo, offset: number, socketIo: boolean) {
  const client = [...info.specs].some((s) => s === "socket.io-client");
  walk(ast, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.property.type !== "Identifier") return;
    const obj = n.callee.object.type === "Identifier" ? n.callee.object.name : "";
    const method = n.callee.property.name;
    const first = str(n.arguments[0]);
    if (ROUTER.test(obj) && HTTP.has(method) && first?.startsWith("/") && n.arguments.length > 1) {
      // A handler last; axios-style calls on a client end with a config object.
      const last = n.arguments.at(-1);
      if (last.type !== "ObjectExpression" && str(last) === undefined) {
        info.endpoints.push({ router: obj, method: method.toUpperCase(), path: first, line: lineOf(n, offset) });
      }
    }
    if (ROUTER.test(obj) && method === "use" && first?.startsWith("/")) {
      for (const a of n.arguments.slice(1)) {
        const id = a.type === "Identifier" ? a : a.type === "MemberExpression" && a.object.type === "Identifier" ? a.object : undefined;
        if (id) info.mounts.push({ prefix: first, name: id.name });
      }
    }
    if (socketIo && !client && /socket$/i.test(obj) && method === "on" && first && !SOCKET_BUILTIN.has(first)) {
      info.endpoints.push({ router: "", method: "SOCKET", path: first, line: lineOf(n, offset) });
    }
  });
}

// ---------- states and tests ----------

const STATEY = /(status|state|stage|phase|role|type|kind|mode|level)s?$/i;

function collectStates(ast: Node, file: string, offset: number, out: CodeState[]) {
  const push = (n: Node, name: string, values: (string | undefined)[]) => {
    const v = [...new Set(values.filter((x): x is string => !!x))];
    if (v.length >= 2) out.push({ name, values: v, file, line: lineOf(n, offset) });
  };
  const unwrap = (n: Node): Node => {
    while (n && (n.type === "TSAsExpression" || n.type === "TSSatisfiesExpression")) n = n.expression;
    if (n?.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "freeze") return unwrap(n.arguments[0]);
    return n;
  };
  walk(ast, (n) => {
    if (n.type === "TSEnumDeclaration") {
      const members = n.body?.members ?? n.members ?? [];
      push(n, n.id.name, members.map((m: Node) => str(m.initializer) ?? m.id.name ?? m.id.value));
    } else if (n.type === "TSTypeAliasDeclaration" && STATEY.test(n.id.name) && n.typeAnnotation.type === "TSUnionType") {
      push(n, n.id.name, n.typeAnnotation.types.map((t: Node) => (t.type === "TSLiteralType" ? str(t.literal) : undefined)));
    } else if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && STATEY.test(n.id.name)) {
      const init = unwrap(n.init);
      if (init?.type === "ArrayExpression" && init.elements.every((e: Node) => e && str(e) !== undefined)) push(n, n.id.name, init.elements.map(str));
      // A lookup of constants only: { PAID: "paid", VOID: "void" }
      else if (init?.type === "ObjectExpression" && init.properties.length && init.properties.every((p: Node) => p.type === "ObjectProperty" && (str(p.value) !== undefined || p.value.type === "NumericLiteral"))) {
        push(n, n.id.name, init.properties.map((p: Node) => keyName(p)));
      }
    }
  });
}

function collectTests(ast: Node, file: string, out: CodeTest[]) {
  walk(ast, (n) => {
    if (n.type !== "CallExpression" || n.callee.type !== "Identifier" || !/^(test|it)$/.test(n.callee.name)) return;
    const title = str(n.arguments[0]);
    if (title && n.arguments.length > 1) out.push({ title, file, line: lineOf(n, 0) });
  });
}

// ---------- controls ----------

const INPUT_ROLE: Record<string, string> = {
  checkbox: "checkbox", radio: "radio", number: "spinbutton", range: "slider", search: "searchbox",
  button: "button", submit: "button", reset: "button", image: "button",
};
const NATIVE: Record<string, string> = { textarea: "textbox", select: "combobox", button: "button" };
const COMPONENT: [RegExp, string][] = [
  [/(Checkbox)$/, "checkbox"], [/(Switch|Toggle)$/, "switch"], [/(Radio)$/, "radio"],
  [/(Select|Dropdown|Combobox|Multiselect|Autocomplete)$/i, "combobox"],
  [/(Input|TextField|Textarea|TextArea)$/, "textbox"], [/Button$/, "button"],
];
const RULES = ["required", "maxlength", "minlength", "min", "max", "step", "pattern"];

interface RawControl {
  tag: string;
  attrs: Map<string, string | true>; // literal values; keys lower-cased
  bound: Map<string, string>; // dynamic values, as source
  text: string;
  line: number;
}

function toControl(raw: RawControl, labels: Map<string, string>, file: string): CodeControl | undefined {
  const tag = raw.tag;
  const lower = tag.toLowerCase();
  const native = tag === lower && (lower === "input" || lower in NATIVE);
  const attr = (k: string) => {
    const v = raw.attrs.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  let role: string | undefined;
  if (native) {
    const type = attr("type")?.toLowerCase() ?? "text";
    if (type === "hidden") return;
    role = lower === "input" ? (INPUT_ROLE[type] ?? "textbox") : NATIVE[lower];
  } else {
    const name = tag.replace(/-(\w)/g, (_, c) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
    if (!/[A-Z-]/.test(tag)) return;
    role = COMPONENT.find(([re]) => re.test(name))?.[1];
  }
  if (!role) return;
  const id = attr("id");
  const name = attr("aria-label") ?? (id ? labels.get(id) : undefined) ?? (role === "button" ? raw.text || attr("value") || attr("title") : undefined) ?? attr("label") ?? attr("placeholder");
  const handle = id ? `#${id}` : attr("name") ? `[name=${attr("name")}]` : undefined;
  if (!name && !handle) return;
  const rules: string[] = [];
  for (const r of RULES) {
    const v = raw.attrs.get(r);
    const dyn = raw.bound.get(r);
    if (v !== undefined) rules.push(v === true || v === "" || r === "required" ? r : `${r}=${v}`);
    else if (dyn) rules.push(`${r} when ${dyn.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  return { control: name ? `${role} ${JSON.stringify(name.slice(0, 80))}` : `${role} ${handle}`, rules, file, line: raw.line };
}

function attrText(v: Node): string | undefined {
  if (!v) return;
  const e = v.type === "JSXExpressionContainer" ? v.expression : v;
  const s = str(e);
  if (s !== undefined) return s;
  // t("Save"), $t("Save")
  if (e.type === "CallExpression" && /^\$?t$/.test(e.callee.name ?? e.callee.property?.name ?? "")) return str(e.arguments[0]);
}

function jsxText(n: Node): string {
  const parts: string[] = [];
  walk(n, (c) => {
    if (c.type === "JSXOpeningElement" || c.type === "JSXClosingElement") return false;
    if (c.type === "JSXText") parts.push(c.value);
    else if (c.type === "JSXExpressionContainer") {
      const t = attrText(c);
      if (t) parts.push(t);
      return isNode(c.expression) && /JSX|Logical|Conditional/.test(c.expression.type);
    }
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function collectJsxControls(ast: Node, code: string, file: string, out: CodeControl[]) {
  const raws: RawControl[] = [];
  const labels = new Map<string, string>();
  walk(ast, (n) => {
    if (n.type !== "JSXElement") return;
    const open = n.openingElement;
    if (open.name.type !== "JSXIdentifier") return;
    const raw: RawControl = { tag: open.name.name, attrs: new Map(), bound: new Map(), text: "", line: lineOf(n, 0) };
    for (const a of open.attributes) {
      if (a.type !== "JSXAttribute" || a.name.type !== "JSXIdentifier") continue;
      const key = a.name.name.toLowerCase();
      const expr = a.value?.type === "JSXExpressionContainer" ? a.value.expression : undefined;
      const text = attrText(a.value);
      if (!a.value || (expr?.type === "BooleanLiteral" && expr.value)) raw.attrs.set(key, true);
      else if (text !== undefined) raw.attrs.set(key, text);
      else if (expr?.type === "NumericLiteral") raw.attrs.set(key, String(expr.value));
      else if (expr && expr.type !== "BooleanLiteral") raw.bound.set(key, code.slice(expr.start, expr.end));
    }
    const htmlFor = raw.attrs.get("htmlfor");
    if (typeof htmlFor === "string") labels.set(htmlFor, jsxText(n));
    if (/button$/i.test(raw.tag)) raw.text = jsxText(n);
    raws.push(raw);
  });
  for (const r of raws) {
    const c = toControl(r, labels, file);
    if (c) out.push(c);
  }
}

/** Controls in a Vue template or an HTML page. */
function collectMarkupControls(markup: string, offset: number, file: string, out: CodeControl[]) {
  // Blank out comments, scripts and styles, keeping line numbers.
  const src = markup.replace(/<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
  const text = (from: number, tag: string) => {
    const end = src.slice(from).search(new RegExp(`</${tag}\\s*>`, "i"));
    if (end < 0) return "";
    return src
      .slice(from, from + Math.min(end, 2000))
      .replace(/\{\{\s*\$?t\(\s*(["'`])(.*?)\1[^}]*\}\}/g, "$2")
      .replace(/\{\{[\s\S]*?\}\}/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };
  const raws: RawControl[] = [];
  const labels = new Map<string, string>();
  let line = 1;
  let at = 0;
  for (const m of src.matchAll(/<([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g)) {
    for (; at < m.index; at++) if (src.charCodeAt(at) === 10) line++;
    const raw: RawControl = { tag: m[1], attrs: new Map(), bound: new Map(), text: "", line: line + offset };
    for (const a of m[2].matchAll(/([@:\w.-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g)) {
      const value = a[2]?.replace(/^(["'])([\s\S]*)\1$/, "$2");
      const key = a[1].toLowerCase();
      if (/^(:|v-bind:)/.test(key)) {
        const k = key.replace(/^(:|v-bind:)/, "");
        const t = value?.match(/^\s*\$?t\(\s*(["'])(.*?)\1\s*\)\s*$/)?.[2] ?? value?.match(/^\s*'([^']*)'\s*$/)?.[1];
        if (t !== undefined) raw.attrs.set(k, t);
        else if (value && /^\d+$/.test(value.trim())) raw.attrs.set(k, value.trim());
        else if (value?.trim() === "true") raw.attrs.set(k, true);
        else if (value?.trim() === "false") continue;
        else if (value) raw.bound.set(k, value);
      } else if (!/^[@.]|^v-/.test(key)) raw.attrs.set(key, value ?? true);
    }
    const after = m.index + m[0].length;
    const forId = raw.tag.toLowerCase() === "label" ? raw.attrs.get("for") : undefined;
    if (typeof forId === "string") labels.set(forId, text(after, raw.tag));
    if (/button$/i.test(raw.tag) && !m[0].endsWith("/>")) raw.text = text(after, raw.tag);
    raws.push(raw);
  }
  for (const r of raws) {
    const c = toControl(r, labels, file);
    if (c) out.push(c);
  }
}

// ---------- import resolution ----------

function resolver(root: string, files: Set<string>) {
  const pkgs = new Map<string, Record<string, unknown> | undefined>();
  const pkgFor = (dir: string): { dir: string; imports?: Record<string, unknown> } | undefined => {
    for (let d = dir; ; d = posix.dirname(d)) {
      if (!pkgs.has(d)) {
        try {
          pkgs.set(d, JSON.parse(readFileSync(join(root, d, "package.json"), "utf8")));
        } catch {
          pkgs.set(d, undefined);
        }
      }
      const p = pkgs.get(d);
      if (p) return { dir: d, imports: p.imports as Record<string, unknown> };
      if (d === "." || d === "" || d === "/") return;
    }
  };
  const asFile = (p: string): string | undefined => {
    const n = posix.normalize(p);
    const tries = [n, ...[".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".mts"].flatMap((e) => [n + e, posix.join(n, `index${e}`)])];
    // In TypeScript, "./x.js" can mean ./x.ts
    if (/\.jsx?$/.test(n)) tries.push(n.replace(/\.js(x?)$/, ".ts$1"), n.replace(/\.js$/, ".tsx"));
    return tries.find((t) => files.has(t));
  };
  const target = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return target((v as Record<string, unknown>).default ?? Object.values(v)[0]);
  };
  return (spec: string, from: string): string | undefined => {
    const dir = posix.dirname(from);
    const clean = spec.split("?")[0];
    if (clean.startsWith(".")) return asFile(posix.join(dir, clean));
    const pkg = pkgFor(dir);
    if (clean.startsWith("#") && pkg?.imports) {
      const exact = target(pkg.imports[clean]);
      if (exact) return asFile(posix.join(pkg.dir, exact));
      for (const [k, v] of Object.entries(pkg.imports)) {
        if (!k.includes("*")) continue;
        const [pre, post] = k.split("*");
        const t = target(v);
        if (t && clean.startsWith(pre) && clean.endsWith(post) && clean.length > pre.length) {
          const hit = asFile(posix.join(pkg.dir, t.replace("*", clean.slice(pre.length, clean.length - post.length))));
          if (hit) return hit;
        }
      }
    }
    // The usual bundler aliases for src/.
    if (/^[@~]\//.test(clean)) return asFile(posix.join(pkg?.dir ?? ".", "src", clean.slice(2)));
  };
}

// ---------- scan ----------

export function scanCode(dir: string): CodeScan {
  const root = resolve(dir);
  const all = listFiles(root);
  const scan: CodeScan = { files: 0, unparsed: [], hashRouting: false, routes: [], controls: [], endpoints: [], states: [], tests: [], imports: {} };
  const source = all.filter((f) => SOURCE.test(f) && !SKIP.test(f));
  const fileSet = new Set(source);
  const infos = new Map<string, FileInfo>();

  const read = (file: string): string | undefined => {
    try {
      const st = lstatSync(join(root, file)); // lstat: never follow a link out of the repo
      if (!st.isFile() || st.size > MAX_BYTES) throw new Error("skipped");
      return readFileSync(join(root, file), "utf8");
    } catch {
      scan.unparsed.push(file);
    }
  };
  const socketIo = all.some((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules/") && /"socket\.io"/.test(safeRead(join(root, f))));

  for (const file of source) {
    const text = read(file);
    if (text === undefined) continue;
    scan.files++;
    const info: FileInfo = { file, specs: new Set(), names: new Map(), routes: [], mounts: [], endpoints: [] };
    infos.set(file, info);

    // [code, parsed as, line offset] blocks to analyze.
    const blocks: { code: string; as: string; offset: number }[] = [];
    if (file.endsWith(".vue")) {
      for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const lang = /lang=["']?(tsx?|jsx)/.exec(m[1])?.[1] ?? "js";
        blocks.push({ code: m[2], as: `x.${lang}`, offset: lines(text.slice(0, m.index + m[0].indexOf(">") + 1)) });
      }
      const open = text.search(/<template\b/i);
      const close = text.lastIndexOf("</template>");
      if (open >= 0 && close > open) collectMarkupControls(text.slice(open, close), lines(text.slice(0, open)), file, scan.controls);
    } else if (file.endsWith(".html")) {
      collectMarkupControls(text, 0, file, scan.controls);
    } else {
      blocks.push({ code: text, as: file, offset: 0 });
    }

    for (const b of blocks) {
      try {
        const ast = parseCode(b.code, b.as).program;
        collectImports(ast, info);
        collectRoutes(ast, info, b.offset);
        collectEndpoints(ast, info, b.offset, socketIo);
        collectStates(ast, file, b.offset, scan.states);
        collectJsxControls(ast, b.code, file, scan.controls);
        if (/\b(createWebHashHistory|HashRouter|createHashRouter)\s*[(<>\s/]/.test(b.code)) scan.hashRouting = true;
      } catch {
        scan.unparsed.push(file);
      }
    }
  }

  for (const file of all.filter((f) => E2E.test(f) && !f.includes("node_modules/"))) {
    const text = read(file);
    if (text === undefined) continue;
    try {
      collectTests(parseCode(text, file).program, file, scan.tests);
    } catch {
      scan.unparsed.push(file);
    }
  }

  const find = resolver(root, fileSet);
  for (const [file, info] of infos) {
    const hits = [...info.specs].map((s) => find(s, file)).filter((f): f is string => !!f && f !== file);
    if (hits.length) scan.imports[file] = [...new Set(hits)];
  }

  // Routes: resolve component names to files.
  const found: (CodeRoute & { splat: boolean; top: boolean })[] = [];
  for (const [file, info] of infos) {
    for (const r of info.routes) {
      const specs = [...r.names.map((n) => info.names.get(n)), ...r.specs];
      const components = [...new Set(specs.map((s) => s && find(s, file)).filter((f): f is string => !!f))];
      found.push({ path: r.path, file, line: r.line, components, splat: r.splat, top: r.top, ...(r.partial ? { partial: true } : {}) });
    }
  }
  // <Routes> inside a component mounted at "/reports/*" is under /reports, even
  // when its paths start with a slash.
  const splats = found.filter((p) => p.splat && !p.partial);
  for (const r of found) {
    if (!r.partial && !r.top) continue;
    const parent = splats.find((p) => p.file !== r.file && p.components.some((c) => c === r.file || scan.imports[c]?.includes(r.file)));
    if (parent) {
      r.path = joinRoute(parent.path, r.path.replace(/^\//, "")).path;
      delete r.partial;
    }
  }
  const byPath = new Map<string, CodeRoute>();
  for (const { splat: _splat, top: _top, ...r } of found) {
    const key = `${r.partial ? "~" : ""}${r.path}`;
    const have = byPath.get(key);
    if (have) have.components = [...new Set([...have.components, ...r.components])];
    else byPath.set(key, r);
  }
  scan.routes = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Endpoints: apply app.use("/prefix", router) across files, up to three deep.
  const mountedAt = new Map<string, { prefix: string; by: string }[]>();
  for (const [file, info] of infos) {
    for (const m of info.mounts) {
      const spec = info.names.get(m.name);
      const target = spec && find(spec, file);
      if (target) mountedAt.set(target, [...(mountedAt.get(target) ?? []), { prefix: m.prefix, by: file }]);
    }
  }
  const prefixes = (file: string, depth = 0): string[] => {
    const ms = mountedAt.get(file);
    if (!ms || depth > 3) return [""];
    return ms.flatMap((m) => prefixes(m.by, depth + 1).map((p) => (p + m.prefix).replace(/\/$/, "")));
  };
  const seen = new Set<string>();
  for (const [file, info] of infos) {
    for (const e of info.endpoints) {
      const local = info.mounts.filter((m) => m.name === e.router).map((m) => m.prefix.replace(/\/$/, ""));
      for (const pre of e.method === "SOCKET" ? [""] : local.length ? local : prefixes(file)) {
        const path = pre && e.path === "/" ? pre : pre + e.path;
        const key = `${e.method} ${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scan.endpoints.push({ method: e.method, path, file, line: e.line });
      }
    }
  }
  const states = new Map(scan.states.map((s) => [`${s.name}=${[...s.values].sort()}`, s]));
  scan.states = [...states.values()];
  scan.unparsed = [...new Set(scan.unparsed)];
  return scan;
}

const lines = (s: string) => s.split("\n").length - 1;
const safeRead = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** Controls a route renders: in its components and the files they import directly. */
export function routeControls(scan: CodeScan, route: CodeRoute): CodeControl[] {
  const files = new Set(route.components.flatMap((c) => [c, ...(scan.imports[c] ?? [])]));
  const own = new Set(route.components);
  const seen = new Set<string>();
  return scan.controls
    .filter((c) => files.has(c.file))
    .sort((a, b) => Number(own.has(b.file)) - Number(own.has(a.file)))
    .filter((c) => {
      const k = `${c.control}|${c.rules}`;
      return !seen.has(k) && seen.add(k);
    });
}

/** Does a concrete path (/status/main) match a route pattern (/status/:slug)? */
export function matchesRoute(pattern: string, path: string): boolean {
  const clean = path.split(/[?#]/)[0].replace(/(.)\/$/, "$1");
  const parts = pattern.replace(/(.)\/$/, "$1").split("/");
  const got = clean.split("/");
  const need = parts.filter((p) => !/\?$/.test(p)).length;
  if (got.length > parts.length || got.length < need) return false;
  return got.every((g, i) => (parts[i].startsWith(":") ? g !== "" : parts[i].replace(/\?$/, "") === g));
}

// Opening these with a saved login could sign it out or change data.
const RISKY = /(log|sign)-?(out|off)|delete|remove|destroy|unsubscribe|cancel|reset|revoke|approve|confirm|callback|[-_]cb$|oauth/i;

/** Full, parameter-free routes that are safe to open directly, for the crawl to try. */
export function seedPaths(scan: CodeScan): { open: string[]; skipped: string[] } {
  if (scan.hashRouting) return { open: [], skipped: [] };
  const full = scan.routes.filter((r) => !r.partial && r.path.startsWith("/") && !/[:*]/.test(r.path)).map((r) => r.path);
  return { open: full.filter((p) => !RISKY.test(p)), skipped: full.filter((p) => RISKY.test(p)) };
}

/** One-screen summary, for `witness scan`. */
export function scanSummary(scan: CodeScan): string {
  const n = (c: number, one: string) => `${c} ${one}${c === 1 ? "" : "s"}`;
  const partial = scan.routes.filter((r) => r.partial).length;
  return [
    `${n(scan.files, "file")}${scan.unparsed.length ? ` (${scan.unparsed.length} couldn't be read or parsed)` : ""}`,
    `${n(scan.routes.length, "route")}${partial ? ` (${partial} with an unknown parent path)` : ""}`,
    `${n(scan.controls.length, "control")}, ${scan.controls.filter((c) => c.rules.length).length} with validation rules`,
    n(scan.endpoints.length, "endpoint"),
    n(scan.states.length, "status or type list"),
    n(scan.tests.length, "end-to-end test"),
  ].join("\n");
}
