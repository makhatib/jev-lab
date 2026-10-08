const http = require("http");
const fs = require("fs");
const path = require("path");
const { scenarios, limits, DEPARTMENTS } = require("./scenarios");

const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || "/data";
const KEYS_FILE = path.join(DATA, "keys.json");
const TS_URL = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1";
const MODEL = process.env.JEV_MODEL || "jev-latest";

// Prices in USD per input/output token.
const PRICE = {
  jev: { in: 0.042 / 1e6, out: 0 },
  opus: { in: 4 / 1e6, out: 20 / 1e6 }, // claude-opus-5-5
};
const BIG_MODEL = "claude-opus-5-5";

let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); } catch {}
const tsKey = () => process.env.TYPESAFE_API_KEY || keys.typesafe;
const antKey = () => process.env.ANTHROPIC_API_KEY || keys.anthropic;
const subToken = () => process.env.CLAUDE_CODE_OAUTH_TOKEN || keys.claudeToken;

const ROUTER_PROMPT = () => "You route customer messages. Reply with JSON only: {\"department\": <one of " + Object.keys(DEPARTMENTS).join(", ") + ">, \"confidence\": <0..1>}.\n" +
  Object.entries(DEPARTMENTS).map(([k, v]) => `- ${k}: ${v}`).join("\n");

// Claude through the user's Claude subscription: headless Claude Code, no tools, one turn.
function claudeCode(text, token = subToken()) {
  const { spawn } = require("child_process");
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const p = spawn("claude", ["-p", "--output-format", "json", "--model", BIG_MODEL, "--effort", "low", "--tools", "",
      "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", ROUTER_PROMPT()],
      { env: { PATH: process.env.PATH, HOME: "/tmp/claude-home", CLAUDE_CODE_OAUTH_TOKEN: token } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    const killer = setTimeout(() => p.kill("SIGKILL"), 60000);   // never let one call hang the server
    p.stdin.end(text);
    p.on("close", () => {
      clearTimeout(killer);
      let d; try { d = JSON.parse(out); } catch { return reject(new Error("Claude Code: " + (err || out).slice(0, 200))); }
      if (d.is_error) return reject(new Error("Claude Code: " + String(d.result).slice(0, 200)));
      let answer = {}; try { answer = JSON.parse(d.result.slice(d.result.indexOf("{"), d.result.lastIndexOf("}") + 1)); } catch {}
      // ms = end to end (same boundary as Jev); apiMs = provider-reported, shown separately.
      resolve({ ms: performance.now() - t0, apiMs: d.duration_api_ms ?? null, model: BIG_MODEL, answer, via: "subscription",
        usage: { input_tokens: d.usage.input_tokens + (d.usage.cache_read_input_tokens || 0) + (d.usage.cache_creation_input_tokens || 0), output_tokens: d.usage.output_tokens },
        cost: typeof d.total_cost_usd === "number" ? d.total_cost_usd : null });
    });
  });
}

function saveKeys() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
}

async function jev(state, questions, key = tsKey()) {
  if (!key) throw httpErr(503, "مفتاح TypeSafe غير موجود. افتح صفحة الإعداد.");
  const t0 = performance.now();
  const r = await fetch(`${TS_URL}/systemone`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: MODEL, questions }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json().catch(() => ({}));
  const ms = performance.now() - t0;   // end to end: request sent until the parsed answer
  if (!r.ok) throw httpErr(r.status, body?.detail?.message || body?.message || `TypeSafe error ${r.status}`);
  const inTok = body.usage?.input_tokens || 0;
  return { ...body, ms, cost: inTok * PRICE.jev.in };
}

// Rough cost of sending the same job to a large LLM. Labelled as an estimate in the UI.
function bigModelEstimate(inputTokens, outputTokens = 80) {
  return inputTokens * PRICE.opus.in + outputTokens * PRICE.opus.out;
}

async function claudeClassify(text) {
  if (subToken()) return claudeCode(text);
  const key = antKey();
  if (!key) return null;
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: key });
  const opts = Object.keys(DEPARTMENTS);
  const t0 = performance.now();
  const msg = await client.messages.create({
    model: BIG_MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    system: "You route customer messages. Reply with JSON only: {\"department\": <one of " + opts.join(", ") + ">, \"confidence\": <0..1>}.\n" +
      Object.entries(DEPARTMENTS).map(([k, v]) => `- ${k}: ${v}`).join("\n"),
    messages: [{ role: "user", content: text }],
  });
  const ms = performance.now() - t0;
  if (msg.stop_reason === "refusal") return { ms, refused: true };
  const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed = {};
  try { parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); } catch {}
  const u = msg.usage;
  return {
    ms, model: msg.model, answer: parsed,
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
    cost: u.input_tokens * PRICE.opus.in + u.output_tokens * PRICE.opus.out,
  };
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

function shuffleCriteria(questions) {
  const q = JSON.parse(JSON.stringify(questions));
  for (const v of Object.values(q)) {
    if (v.type === "choice") v.criteria = Object.fromEntries(Object.entries(v.criteria).reverse());
  }
  return q;
}

const routes = {
  "GET /api/status": async () => ({ typesafe: !!tsKey(), anthropic: !!(subToken() || antKey()), claudeVia: subToken() ? "subscription" : antKey() ? "api" : null, model: MODEL, prices: PRICE }),

  // Keys can be set once; replacing an existing key needs an explicit "replace" (the UI asks for it).
  "POST /api/setup": async (b) => {
    const out = {};
    const has = { typesafeKey: keys.typesafe, claudeToken: keys.claudeToken, anthropicKey: keys.anthropic };
    for (const k of Object.keys(has)) if (b[k] && has[k] && b.replace !== true) throw httpErr(409, "المفتاح موجود. فعّل «استبدال» لتغييره.");
    if (b.typesafeKey) {
      const r = await fetch(`${TS_URL}/models`, { headers: { Authorization: `Bearer ${b.typesafeKey}` } });
      if (!r.ok) throw httpErr(400, "مفتاح TypeSafe غير صحيح (" + r.status + ")");
      keys.typesafe = b.typesafeKey.trim();
      out.typesafe = (await r.json()).models?.map((m) => m.name) || true;
    }
    if (b.claudeToken) {
      await claudeCode("مرحبا", b.claudeToken.trim()).catch((e) => { throw httpErr(400, "توكن اشتراك Claude غير صحيح: " + e.message); });
      keys.claudeToken = b.claudeToken.trim();
      out.claude = "subscription";
    }
    if (b.anthropicKey) {
      const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": b.anthropicKey.trim(), "anthropic-version": "2023-06-01" } });
      if (!r.ok) throw httpErr(400, "مفتاح Anthropic غير صحيح (" + r.status + ")");
      keys.anthropic = b.anthropicKey.trim();
      out.anthropic = true;
    }
    saveKeys();
    return out;
  },

  "POST /api/run": async (b) => {
    const sc = scenarios[b.scenario];
    if (!sc) throw httpErr(400, "سيناريو غير معروف");
    const questions = sc.questions();
    const r = await jev(b.state, questions);
    const decision = sc.decide(r.answers, b.opts || {});
    return { ...r, questions, decision, estimate: bigModelEstimate(r.usage?.input_tokens || 0) };
  },

  "POST /api/raw": async (b) => {
    if (typeof b.state !== "string" || b.state.length > 20000) throw httpErr(400, "النص طويل جداً");
    if (!b.questions || typeof b.questions !== "object" || Object.keys(b.questions).length > 20) throw httpErr(400, "حد أقصى 20 سؤال");
    const r = await jev(b.state, b.questions);
    return { ...r, estimate: bigModelEstimate(r.usage?.input_tokens || 0) };
  },

  // Same message, same question, options in two orders: does the answer depend on option order?
  "POST /api/consistency": async (b) => {
    const q = { department: scenarios.triage.questions().department };
    const [a, c] = await Promise.all([jev(b.state, q), jev(b.state, shuffleCriteria(q))]);
    return { forward: a, reversed: c };
  },

  // The UI calls each side separately so each timer stops when its own answer arrives.
  "POST /api/race": async (b) => {
    const q = { department: scenarios.triage.questions().department };
    if (b.which === "claude") return { claude: await claudeClassify(b.state).catch((e) => ({ error: e.message })), bigModel: BIG_MODEL };
    const j = await jev(b.state, q);
    return { jev: j, estimate: bigModelEstimate(j.usage?.input_tokens || 0), bigModel: BIG_MODEL };
  },

  // Fan-out: many messages, one request. One Choice per message, pointed at it by name.
  // Many messages at once: one small request per message, all in parallel.
  // (Packing them into one state and pointing at messages[i] loses accuracy on long lists.)
  "POST /api/batch": async (b) => {
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(0, 20).map((m) => String(m).slice(0, 1000));
    const q = { department: scenarios.triage.questions().department };
    const t0 = performance.now();
    const rs = new Array(msgs.length);
    let next = 0;   // at most 8 requests in flight
    await Promise.all(Array.from({ length: Math.min(8, msgs.length) }, async () => {
      while (next < msgs.length) { const i = next++; rs[i] = await jev(msgs[i], q); }
    }));
    const inTok = rs.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0);
    const answers = Object.fromEntries(rs.map((r, i) => ["m" + i, r.answers.department]));
    return { model: rs[0]?.model, answers, ms: performance.now() - t0, requests: rs.length,
      usage: { input_tokens: inTok }, cost: rs.reduce((s, r) => s + r.cost, 0), estimate: bigModelEstimate(inTok, 40 * msgs.length) };
  },

  "GET /api/limits": async () => limits.map(({ code, detail, question, ...l }) => ({ ...l, question })),

  "POST /api/limit": async (b) => {
    const l = limits.find((x) => x.id === b.id);
    if (!l) throw httpErr(400, "غير معروف");
    const r = await jev(l.state, { q: l.question });
    return { ...r, code: l.code(l.state), detail: l.detail ? l.detail() : null, lesson: l.lesson };
  },
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

let inFlight = 0;   // paid calls in progress, across all users
const send = (res, status, obj) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const key = `${req.method} ${url.pathname}`;
  if (routes[key]) {
    if (req.method === "POST") {
      // CSRF guard: same-origin JSON only.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "cross-origin request refused" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON only" });
      if (inFlight >= 6) return send(res, 429, { error: "مشغول، جرّب بعد لحظات" });
    }
    let body = "";
    for await (const c of req) { body += c; if (body.length > 65536) return send(res, 413, { error: "too large" }); }
    if (req.method === "POST") inFlight++;
    try {
      const data = await routes[key](body ? JSON.parse(body) : {});
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(e.status || 500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      if (req.method === "POST") inFlight--;
    }
    return;
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  if (p === "/setup") p = "/index.html";
  const f = path.join(__dirname, "public", path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(PORT, () => console.log("Jev Lab on", PORT));
