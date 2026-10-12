const http = require("http");
const fs = require("fs");
const path = require("path");
const { scenarios, limits, DEPARTMENTS, BENCH, triageQuestionAr, triageQuestionsAr, vision } = require("./scenarios");

const PORT = process.env.PORT || 8080;
const DATA = process.env.DATA_DIR || "/data";
const KEYS_FILE = path.join(DATA, "keys.json");
const TS_URL = process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai/v1";
const MODEL = process.env.JEV_MODEL || "jev-latest";
const OPENAI_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const LUNA = process.env.DECISIONS_MODEL || "gpt-6-luna";   // OpenAI Decisions API (public beta)

// Prices in USD per input/output token.
const PRICE = {
  jev: { in: 0.042 / 1e6, out: 0 },
  opus: { in: 4 / 1e6, out: 20 / 1e6 }, // claude-opus-5-5
  luna: { in: 0.10 / 1e6, out: 0 },     // gpt-6-luna on /v1/decisions: input only
};
const BIG_MODEL = "claude-opus-5-5";

let keys = {};
try { keys = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); } catch {}
const tsKey = () => process.env.TYPESAFE_API_KEY || keys.typesafe;
const antKey = () => process.env.ANTHROPIC_API_KEY || keys.anthropic;
const subToken = () => process.env.CLAUDE_CODE_OAUTH_TOKEN || keys.claudeToken;
const oaKey = () => process.env.OPENAI_API_KEY || keys.openai;

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

// ---------- OpenAI Decisions (gpt-6-luna) ----------
// Jev and Decisions ask the same three kinds of question, so one question set drives both:
//   Jev choice {criteria: {value: description}}  -> Decisions choice {choices: [{value, description}]}
//   Jev score  {criteria: [label, ...]}          -> Decisions score  {levels: [{label}]}
//   Jev noul   {instructions}                    -> Decisions predicate
function toDecisions(questions) {
  return Object.entries(questions).map(([name, q]) => {
    if (q.type === "choice") return { type: "choice", name, instructions: q.instructions,
      choices: Object.entries(q.criteria).map(([value, d]) => (d ? { value, description: d } : { value })) };
    if (q.type === "score") return { type: "score", name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label })) };
    if (q.type === "noul") return { type: "predicate", name, instructions: q.instructions };
    throw httpErr(400, "نوع سؤال غير معروف: " + q.type);
  });
}

// Back to Jev's answer shape, so the same decide() code and the same UI read both models.
function fromDecisions(answers) {
  const out = {};
  for (const a of answers || []) {
    if (a.type === "predicate") out[a.name] = { type: "noul", noul: a.probability };
    else if (a.type === "choice") out[a.name] = { type: "choice", choice: String(a.choice), confidence: a.confidence,
      probabilities: Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability])) };
    else if (a.type === "score") out[a.name] = { type: "score", score: a.score, confidence: a.confidence,
      legend: Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.label])),
      probabilities: Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability])) };
    else out[a.name] = { type: "refusal" };
  }
  return out;
}

// input: a text string, or {text, image} where image is a data: URL (Decisions takes inline base64 only).
async function luna(input, questions, key = oaKey()) {
  if (!key) throw httpErr(503, "مفتاح OpenAI غير موجود. افتح صفحة الإعداد.");
  const body = { model: LUNA, questions: toDecisions(questions),
    input: typeof input === "string" ? input : [{ role: "user", content: [
      ...(input.text ? [{ type: "input_text", text: input.text }] : []),
      { type: "input_image", image_url: input.image }] }] };
  const t0 = performance.now();
  const r = await fetch(`${OPENAI_URL}/decisions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  const ms = performance.now() - t0;   // same boundary as jev(): request sent until the parsed answer
  if (!r.ok) throw httpErr(r.status === 401 ? 400 : r.status, "OpenAI: " + (j?.error?.message || `error ${r.status}`));
  const inTok = j.usage?.input_tokens || 0;
  return { model: j.model || LUNA, answers: fromDecisions(j.answers), raw: j.answers, usage: j.usage, ms, cost: inTok * PRICE.luna.in };
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
  "GET /api/status": async () => ({ typesafe: !!tsKey(), anthropic: !!(subToken() || antKey()), claudeVia: subToken() ? "subscription" : antKey() ? "api" : null, openai: !!oaKey(), luna: LUNA, model: MODEL, prices: PRICE }),

  // Keys can be set once; replacing an existing key needs an explicit "replace" (the UI asks for it).
  "POST /api/setup": async (b) => {
    const out = {};
    const has = { typesafeKey: keys.typesafe, claudeToken: keys.claudeToken, anthropicKey: keys.anthropic, openaiKey: keys.openai };
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
    if (b.openaiKey) {
      const r = await fetch(`${OPENAI_URL}/models`, { headers: { Authorization: `Bearer ${b.openaiKey.trim()}` } });
      if (!r.ok) throw httpErr(400, "مفتاح OpenAI غير صحيح (" + r.status + ")");
      keys.openai = b.openaiKey.trim();
      out.openai = true;
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
    const fn = b.which === "luna" ? luna : jev;
    const [a, c] = await Promise.all([fn(b.state, q), fn(b.state, shuffleCriteria(q))]);
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

  // Jev vs OpenAI Decisions: same text, same questions, same decide() code.
  // The UI calls each side separately so each timer stops when its own answer arrives.
  "POST /api/duel": async (b) => {
    const sc = scenarios[b.scenario];
    if (!sc) throw httpErr(400, "سيناريو غير معروف");
    if (typeof b.state !== "string" || !b.state.trim() || b.state.length > 5000) throw httpErr(400, "النص فاضي أو طويل جداً");
    const questions = sc.questions();
    if (b.lang === "ar" && b.scenario === "triage") Object.assign(questions, triageQuestionsAr());
    const r = b.which === "luna" ? await luna(b.state, questions) : await jev(b.state, questions);
    const { raw, ...rest } = r;
    return { ...rest, decision: sc.decide(r.answers, b.opts || {}), questions };
  },

  // 20 messages with a known answer, through both models. Accuracy, latency per request, cost.
  "POST /api/bench": async (b) => {
    const q = { department: b.lang === "ar" ? triageQuestionAr() : scenarios.triage.questions().department };
    const run = async (fn) => {
      const rs = new Array(BENCH.length); let next = 0; const t0 = performance.now();
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next < BENCH.length) {
          const i = next++;
          rs[i] = await fn(BENCH[i][0], q).catch((e) => ({ error: e.message }));
        }
      }));
      const wall = performance.now() - t0;
      const ok = rs.filter((r) => !r.error);
      const lat = ok.map((r) => r.ms).sort((a, c) => a - c);
      const at = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
      const rows = rs.map((r, i) => r.error ? { error: r.error } : r.answers.department.type === "refusal" ? { refusal: true, ms: r.ms }
        : { choice: r.answers.department.choice, confidence: r.answers.department.confidence, ms: r.ms, right: r.answers.department.choice === BENCH[i][1] });
      // Latency and cost cover answered requests only; the UI hides projections when anything failed.
      return { model: ok[0]?.model, wall, p50: at(0.5), p95: at(0.95), correct: rows.filter((x) => x.right).length, errors: rs.length - ok.length,
        refusals: rows.filter((x) => x.refusal).length, complete: rs.length === ok.length && !rows.some((x) => x.refusal),
        tokens: ok.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0), cost: ok.reduce((s, r) => s + r.cost, 0), rows };
    };
    const [J, L] = await Promise.all([run(jev), oaKey() ? run(luna) : Promise.resolve(null)]);
    return { messages: BENCH.map(([text, label]) => ({ text, label })), jev: J, luna: L };
  },

  // Images: only Decisions reads them. Jev is text-only, so the UI says so instead of faking a result.
  "POST /api/vision": async (b) => {
    const v = vision[b.preset];
    if (!v) throw httpErr(400, "غير معروف");
    if (typeof b.image !== "string" || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(b.image)) throw httpErr(400, "الصورة لازم تكون PNG أو JPEG أو WebP");
    const note = typeof b.note === "string" ? b.note.slice(0, 1000).trim() : "";
    const questions = v.questions(!!note);
    const r = await luna({ text: v.prompt + (note ? "\nCustomer's message: " + note : ""), image: b.image }, questions);
    const { raw, ...rest } = r;
    return { ...rest, decision: v.decide(r.answers), questions };
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
    const max = key === "POST /api/vision" ? 4_000_000 : 65536;   // images are downscaled in the browser first
    for await (const c of req) { body += c; if (body.length > max) return send(res, 413, { error: "too large" }); }
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
