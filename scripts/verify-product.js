/* eslint-disable */
// Production-behavior suite: transcript quality, question lifecycle,
// streaming answers + abort, OCR cleanup, .env config. Deterministic;
// provider streaming is proven against local SSE fixtures (no keys).

const path = require("path");
const http = require("http");
const dist = path.resolve(__dirname, "..", "dist");

const { isTranscriptGarbage } = require(path.join(dist, "main", "transcription", "TranscriptionManager.js"));
const { QuestionDetector, isWeakFragment } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { SessionManager } = require(path.join(dist, "main", "session", "InterviewSession.js"));
const { AnswerEngine } = require(path.join(dist, "main", "reasoning", "AnswerEngine.js"));
const { ModelRouter } = require(path.join(dist, "main", "reasoning", "ModelRouter.js"));
const { MockLLMProvider, OpenAICompatibleLLMProvider, GeminiLLMProvider } = require(path.join(dist, "main", "reasoning", "LLMProvider.js"));
const { describeProvider } = require(path.join(dist, "main", "reasoning", "diagnostics.js"));
const { cleanOcrText } = require(path.join(dist, "main", "screen", "ocr.js"));
const { applyDotEnvText } = require(path.join(dist, "main", "config.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fev(source, text, ts, speaker) {
  return { id: `t-${ts}`, source, speaker: speaker || "interviewer", text, timestamp: ts, isFinal: true, confidence: 1 };
}

// [1] ASR garbage never enters the pipeline; real speech always passes.
function t1() {
  console.log("\n[1] Transcript garbage filter");
  for (const g of ["[BLANK_AUDIO]", "[music]", "[ Silence ]", "...", "?", "a", "aaaaaaa", "", "   "]) {
    assert(isTranscriptGarbage(g) === true, `garbage dropped: ${JSON.stringify(g)}`);
  }
  for (const ok of ["Tell me about React.", "um, well...", "[mock transcription — 1.25s of audio]", "Kubernetes?", "Okay, thanks."]) {
    assert(isTranscriptGarbage(ok) === false, `speech kept: ${JSON.stringify(ok)}`);
  }
}

// [2] Split utterance becomes ONE logical question (no double answer).
function t2() {
  console.log("\n[2] Question continuation merge");
  const qd = new QuestionDetector();
  const emitted = [];
  qd.on("question", (q) => emitted.push(q));
  const r1 = qd.handle(fev("system", "Can you tell me", 1000), []);
  assert(r1 === null && emitted.length === 0, "weak fragment held (no premature answer)");
  assert(isWeakFragment("Can you tell me", qd.classify("Can you tell me")) === true, "fragment classified weak");
  const r2 = qd.handle(fev("system", "about a difficult project you worked on?", 2500), []);
  assert(r2 !== null && emitted.length === 1, "continuation completes exactly ONE question");
  assert(r2.question === "Can you tell me about a difficult project you worked on?", "merged text correct (got: " + (r2 && r2.question) + ")");
  assert(r2.type === "behavioral", "merged type behavioral (got " + (r2 && r2.type) + ")");
}

// [3] Emitted fragment + tail merges with supersedes; history marks stale.
function t3() {
  console.log("\n[3] Post-emit supersede + stale marking");
  const qd = new QuestionDetector();
  const emitted = [];
  qd.on("question", (q) => emitted.push(q));
  const q1 = qd.handle(fev("system", "Tell me about your experience", 1000), []);
  assert(q1 !== null && !q1.supersedes, "strong fragment emits immediately");
  const q2 = qd.handle(fev("system", "at your last company.", 3000), []);
  assert(q2 !== null && q2.supersedes === q1.id, "tail merges with supersedes link");
  assert(q2.question === "Tell me about your experience at your last company.", "merged tail text");
  const sm = new SessionManager();
  const s = sm.createSession({});
  sm.startSession(s.id);
  sm.recordQuestion(s.id, { id: q1.id, text: q1.question, type: q1.type, timestamp: 1, source: "system", confidence: 0.9 });
  sm.recordAnswer(s.id, { id: "a1", questionId: q1.id, role: "fast", text: "frag", provider: "p", model: "m", latencyMs: 1, timestamp: 2, status: "ok" });
  const n = sm.markAnswersStale(s.id, q2.supersedes);
  assert(n === 1 && sm.answersFor(s.id, q1.id)[0].stale === true, "fragment answers marked stale (ONE live answer)");
}

// [4] Stale pending fragment flushes instead of merging foreign speech.
function t4() {
  console.log("\n[4] Fragment expiry + foreign-speaker flush");
  const qd = new QuestionDetector();
  const emitted = [];
  qd.on("question", (q) => emitted.push(q));
  assert(qd.handle(fev("system", "Can you tell me", 1000), []) === null, "held");
  const late = qd.handle(fev("system", "What is Kubernetes?", 30000), []);
  assert(late !== null && emitted.length === 2, "expired fragment flushed, new question separate (got " + emitted.length + ")");
  assert(emitted[0].question === "Can you tell me", "flushed fragment intact");
}

// [5] Streaming engine: partials render, final records, abort hard-cancels.
async function t5() {
  console.log("\n[5] Streaming answers + abort");
  const engine = new AnswerEngine(new ModelRouter(new MockLLMProvider("fast", 5), new MockLLMProvider("strong", 5)));
  const fastEvts = [];
  const strongEvts = [];
  engine.on("fast-answer", (a) => fastEvts.push(a));
  engine.on("strong-answer", (a) => strongEvts.push(a));
  const res = await engine.answer({ questionId: "q1", question: "What is React?", questionType: "technical", recentContext: [] });
  assert(fastEvts.length >= 2 && fastEvts.slice(0, -1).every((e) => e.partial === true), "fast streams partials then final (" + fastEvts.length + " events)");
  assert(fastEvts[fastEvts.length - 1].partial !== true && res.fast.length > 0, "fast final is complete");
  assert(strongEvts.length >= 1 && res.strong.length > 0, "strong completes after fast");
  // Abort: slow provider, cancel mid-flight -> no final leaks.
  const slow = new AnswerEngine(new ModelRouter(new MockLLMProvider("fast", 500), new MockLLMProvider("strong", 500)));
  const leaked = [];
  slow.on("fast-answer", (a) => { if (!a.partial) leaked.push(a); });
  slow.on("strong-answer", (a) => { if (!a.partial) leaked.push(a); });
  const p = slow.answer({ questionId: "q2", question: "What is SQL?", recentContext: [] });
  await sleep(30);
  slow.cancel();
  await p;
  assert(leaked.length === 0, "cancelled generation emits no final (stale dropped, HTTP aborted)");
}

// SSE fixture: OpenAI-style + Gemini-style chunk streams.
function startSse(handler) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => handler(req, body, res));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
function sseBody(items) {
  return items.map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
}

// [6] Real SSE streaming paths (fixture = AUTOMATED TEST of production code).
async function t6() {
  console.log("\n[6] Provider SSE streaming (fixture)");
  // OpenAI-compatible (/v1/chat/completions with stream:true).
  const open = await startSse((req, body, res) => {
    const j = JSON.parse(body);
    if (j.stream !== true) { res.writeHead(400); res.end(); return; }
    // Connection: close keeps fixture sockets out of the client's keep-alive
    // pool (avoids a Windows libuv teardown race at process exit).
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "close" });
    res.end(sseBody([
      { choices: [{ delta: { content: "Hello " } }] },
      "MALFORMED-CHUNK",
      { choices: [{ delta: { content: "world" } }] },
    ]).replace('data: "MALFORMED-CHUNK"\n\n', 'not-a-data-line\n\n'));
  });
  try {
    const p = new OpenAICompatibleLLMProvider({ endpoint: open.url, model: "m", apiKey: "k", timeoutMs: 5000 });
    const deltas = [];
    const r = await p.generateStream({ prompt: "hi", maxTokens: 50 }, (d) => deltas.push(d));
    assert(r.text === "Hello world" && deltas.join("") === "Hello world", "OpenAI SSE accumulates deltas, skips wire noise");
  } finally { open.srv.close(); }
  // Gemini (:streamGenerateContent SSE).
  const gem = await startSse((req, body, res) => {
    if (!req.url.includes(":streamGenerateContent")) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "close" });
    res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hel" }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "lo" }] } }] })}\n\n`);
  });
  try {
    const g = new GeminiLLMProvider({ endpoint: gem.url, model: "m", apiKey: "k", timeoutMs: 5000 });
    const deltas = [];
    const r = await g.generateStream({ prompt: "hi", maxTokens: 50 }, (d) => deltas.push(d));
    assert(r.text === "Hello" && deltas.length === 2, "Gemini SSE accumulates part deltas");
  } finally { gem.srv.close(); }
  assert(describeProvider(new MockLLMProvider("fast")).streaming === "supported", "diagnostics reports streaming support honestly");
}

// [7] OCR cleanup: dedupe, hyphen join, garbage drop, code preserved.
function t7() {
  console.log("\n[7] OCR text cleanup");
  const raw = [
    "How would you design a",
    "scalable payment",
    "scalable payment",
    "system?",
    "experi-",
    "ence with Postgres",
    "|",
    "function twoSum(nums, target) {",
    "    return nums;",
    "}",
    "bcdfghjklmnpqrstvwxyz",
  ].join("\n");
  const out = cleanOcrText(raw);
  assert(out.includes("How would you design a scalable payment system?"), "prose joined + deduped");
  assert(out.includes("experience with Postgres"), "hyphen break joined");
  assert(!out.includes("bcdfghjklmnpqrstvwxyz") && !out.includes("\n|\n"), "garbage lines dropped");
  assert(out.includes("function twoSum(nums, target) {") && out.includes("    return nums;"), "code lines preserved verbatim");
}

// [8] .env config: INTERVIA_* only, real env wins, quotes handled.
function t8() {
  console.log("\n[8] .env loader");
  delete process.env.INTERVIA_TEST_DOTENV;
  process.env.INTERVIA_TEST_KEEP = "real";
  applyDotEnvText('# comment\nINTERVIA_TEST_DOTENV="hello world"\nINTERVIA_TEST_KEEP=dotenv\nPATH=/evil\nNOT عدد=1\n');
  assert(process.env.INTERVIA_TEST_DOTENV === "hello world", "quoted value parsed");
  assert(process.env.INTERVIA_TEST_KEEP === "real", "real environment wins over .env");
  assert(process.env.PATH !== "/evil", "non-INTERVIA_ keys ignored");
  delete process.env.INTERVIA_TEST_DOTENV;
  delete process.env.INTERVIA_TEST_KEEP;
}

// [9] Overlay lifecycle states wired (static contract).
function t9() {
  console.log("\n[9] Overlay answer lifecycle");
  const fs = require("fs");
  const html = fs.readFileSync(path.join(dist, "renderer", "overlay.html"), "utf8");
  const js = fs.readFileSync(path.join(dist, "renderer", "overlay.js"), "utf8");
  assert(html.includes("answer-state"), "state pill present");
  for (const s of ["THINKING", "PRELIMINARY", "REFINING", "REFINED", "UNAVAILABLE"]) {
    assert(js.includes(s), `state ${s} rendered`);
  }
  assert(/renderAnswer[\s\S]{0,400}partial/.test(js), "partials render progressively (not gated)");
}

// [10] Provider config: sanitize, persist, merge, redact.
function t10() {
  console.log("\n[10] Provider configuration + key hygiene");
  const PC = require(path.join(dist, "main", "reasoning", "ProviderConfig.js"));
  const dirty = PC.sanitizeProviderConfig({ fastProvider: "GEMINI", fastModel: "  gemini-x  ", strongProvider: "bogus", sttProvider: "GROQ", visionMode: "REMOTE", extra: 1 });
  assert(dirty.fastProvider === "gemini" && dirty.fastModel === "gemini-x", "provider/model normalized");
  assert(dirty.strongProvider === "mock" && dirty.sttProvider === "groq" && dirty.visionMode === "remote", "unknown rejected, enums normalized");
  assert(!("extra" in dirty), "unknown fields dropped");
  const k = PC.sanitizeProviderKeys({ gemini: "  K1 ", minimax: "", groq: null, openaiEndpoint: "https://x" });
  assert(k.gemini === "K1" && !("minimax" in k) && k.openaiEndpoint === "https://x", "keys trimmed, empties dropped");
  // Roundtrip + merge through a real store in a temp dir.
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intervia-pcfg-"));
  try {
    const { JsonFileStorage } = require(path.join(dist, "main", "candidates", "stores.js"));
    const store = new JsonFileStorage(dir);
    PC.saveProviderConfig(store, { fastProvider: "gemini", fastModel: "m1", strongProvider: "mock", strongModel: "", sttProvider: "whisper-server", visionMode: "local" });
    const back = PC.loadProviderConfig(store);
    assert(back.fastProvider === "gemini" && back.fastModel === "m1", "config persists");
    PC.saveProviderKeys(store, { gemini: "SECRET-A" });
    PC.saveProviderKeys(store, { minimax: "SECRET-B" });
    const merged = PC.loadProviderKeys(store);
    assert(merged.gemini === "SECRET-A" && merged.minimax === "SECRET-B", "blank fields keep saved keys (merge)");
    const presence = PC.keysPresent(merged);
    assert(Object.values(presence).every((v) => typeof v === "boolean"), "keysPresent is booleans-only (redacted)");
    assert(JSON.stringify(presence).indexOf("SECRET-A") === -1, "no key value in presence payload");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// [11] Runtime provider swaps (no restart needed, except STT-while-capturing).
async function t11() {
  console.log("\n[11] Runtime provider swaps");
  const { ModelRouter: MR } = { ModelRouter: require(path.join(dist, "main", "reasoning", "ModelRouter.js")).ModelRouter };
  const { MockLLMProvider: Mock } = { MockLLMProvider: require(path.join(dist, "main", "reasoning", "LLMProvider.js")).MockLLMProvider };
  const router = new MR(new Mock("fast", 1), new Mock("strong", 1));
  const swapped = { name: "custom-llm", isAvailable: () => true, generate: async () => ({ text: "SWAPPED", model: "c", latencyMs: 1 }) };
  router.setProviders(swapped, swapped);
  assert(router.getFastName() === "custom-llm" && router.getStrongName() === "custom-llm", "router swaps live");
  const { AnswerEngine: AE } = { AnswerEngine: require(path.join(dist, "main", "reasoning", "AnswerEngine.js")).AnswerEngine };
  const eng = new AE(new MR(new Mock("fast", 1), new Mock("strong", 1)));
  eng.setProviders(swapped, swapped);
  const res = await eng.answer({ questionId: "q", question: "Q?", recentContext: [] });
  assert(res.fast === "SWAPPED", "engine uses swapped providers");
  // STT swap: refused while started, applied while stopped.
  const TM = require(path.join(dist, "main", "transcription", "TranscriptionManager.js")).TranscriptionManager;
  const WP = require(path.join(dist, "main", "transcription", "providers", "WhisperServerProvider.js")).WhisperServerProvider;
  const mgr = new TM(new WP({ endpoint: "http://127.0.0.1:9", timeoutMs: 500 }));
  await mgr.init();
  mgr.start();
  const refused = await mgr.setProvider(new WP({ endpoint: "http://127.0.0.1:9", timeoutMs: 500 }));
  assert(refused === false, "STT swap refused while capturing");
  mgr.stop();
  const applied = await mgr.setProvider(new WP({ endpoint: "http://127.0.0.1:9", timeoutMs: 500 }));
  assert(applied === true, "STT swap applies while stopped");
  // Vision mode switch (local stays upload-free by construction).
  const SCR = require(path.join(dist, "main", "screen", "index.js"));
  const IC = require(path.join(dist, "main", "conversation", "InterviewContext.js")).InterviewContext;
  const QD = require(path.join(dist, "main", "conversation", "QuestionDetector.js")).QuestionDetector;
  const cap = { isMonitoring: () => false };
  const smgr = new SCR.ScreenContextManager(cap, new SCR.MockOCRProvider(), new SCR.MockVisionProvider([]), new IC(), new QD(), {});
  smgr.setVisionMode("remote");
  assert(smgr.getStatus().visionMode === "remote", "vision mode switches at runtime");
  smgr.setVisionMode("bogus");
  assert(smgr.getStatus().visionMode === "remote", "invalid vision mode ignored");
}

// [12] Spoken style + pronoun follow-ups in prompts.
function t12() {
  console.log("\n[12] Spoken answer style");
  const PB = require(path.join(dist, "main", "reasoning", "PromptBuilder.js"));
  const AE2 = require(path.join(dist, "main", "reasoning", "AnswerEngine.js"));
  const p = PB.buildAnswerPrompt({ question: "Tell me about React.", questionType: "technical", recentContext: [], screenEvents: [], candidateMode: "real" });
  assert(/SPOKEN/i.test(p) && !/As an AI language model/i.test(p), "spoken guidance present, no AI preamble");
  assert(/4-8 spoken sentences/.test(p), "medium default length guidance");
  const short = PB.buildAnswerPrompt({ question: "Q?", recentContext: [], screenEvents: [], answerLength: "short" });
  assert(/2-4 spoken sentences/.test(short), "SHORT means 2-4 spoken sentences");
  assert(/pronouns/i.test(AE2.strategySystemPrompt("follow_up", false)), "follow-ups resolve pronouns from context");
  assert(/STAR/.test(AE2.strategySystemPrompt("behavioral", false)), "behavioral strategy intact");
}

// [13] Editor save path: prune + re-derive, resume facts preserved.
function t13() {
  console.log("\n[13] Profile editor provenance");
  const CP = require(path.join(dist, "main", "candidates", "CandidateProfile.js"));
  const PE = require(path.join(dist, "main", "candidates", "ProfileExtractor.js"));
  const profile = CP.emptyProfile("Ed");
  CP.addVerifiedFact(profile, { text: "Skill: React", category: "skill", source: "resume", evidence: "resume skills" });
  CP.addVerifiedFact(profile, { text: "Skill: Old", category: "skill", source: "user-entered", evidence: "manual edit" });
  CP.addVerifiedFact(profile, { text: "Years of experience: 3", category: "general", source: "user-entered", evidence: "manual edit" });
  const removed = CP.pruneManagedUserFacts(profile);
  assert(removed === 2, "stale user-entered facts pruned (got " + removed + ")");
  assert(profile.verifiedFacts.length === 1 && profile.verifiedFacts[0].source === "resume", "resume facts untouched");
  PE.applyProfilePatch(profile, { skills: ["React", "TypeScript"] });
  const texts = profile.verifiedFacts.map((f) => f.text);
  const lower = texts.map((t) => t.toLowerCase());
  assert(lower.some((t) => t.includes("typescript")) && lower.filter((t) => t.includes("react")).length === 2, "facts re-derived without duplicates (resume React + user-entered set)");
}

// [14] Overlay product line: STT + answers + throttled streams.
function t14() {
  console.log("\n[14] Overlay product UX");
  const fs = require("fs");
  const js = fs.readFileSync(path.join(dist, "renderer", "overlay.js"), "utf8");
  assert(js.includes("Answers:"), "provider line shows answer providers + mode");
  assert(js.includes("renderStreamsSoon"), "stream paints throttled (perf)");
}

// [15] Production placeholder sweep (user-visible fakes must not exist).
function t15() {
  console.log("\n[15] Placeholder sweep");
  const fs = require("fs");
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|ts)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(dist, "main"));
  walk(path.join(dist, "renderer"));
  walk(path.join(dist, "preload"));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const pat of ["[stub answer", "[mock answer", "coming soon", "not implemented", "TODO", "FIXME", "lorem ipsum"]) {
      if (src.toLowerCase().includes(pat.toLowerCase())) bad.push(path.basename(f) + ":" + pat);
    }
  }
  assert(bad.length === 0, "no user-facing placeholders (" + (bad.slice(0, 3).join(", ") || "clean") + ")");
}

async function main() {
  console.log("Intervia production-behavior suite (quality + lifecycle + streaming)");
  t1(); t2(); t3(); t4(); await t5(); await t6(); t7(); t8(); t9(); t10(); await t11(); t12(); t13(); t14(); t15();
  console.log("\n=================================");
  console.log(`PRODUCT SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL PRODUCT TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
