/* eslint-disable */
// End-to-end interview-pipeline suite (REAL behavior, deterministic harness).
// Uses a local stub whisper-server over real HTTP (proves the actual WAV
// protocol path) — no mocks of the provider itself, no randomness, no keys.

const path = require("path");
const http = require("http");
const dist = path.resolve(__dirname, "..", "dist");

const { WhisperServerProvider } = require(path.join(dist, "main", "transcription", "providers", "WhisperServerProvider.js"));
const { GroqWhisperProvider } = require(path.join(dist, "main", "transcription", "providers", "GroqWhisperProvider.js"));
const { TranscriptionManager } = require(path.join(dist, "main", "transcription", "TranscriptionManager.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { buildAnswerPrompt } = require(path.join(dist, "main", "reasoning", "PromptBuilder.js"));
const { selectRelevantContext } = require(path.join(dist, "main", "candidates", "Relevance.js"));
const { emptyProfile, addVerifiedFact } = require(path.join(dist, "main", "candidates", "CandidateProfile.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function sinePcm(n, freq, sr, amp) {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp * 32767);
  return out;
}
function silence(n) { return new Int16Array(n); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local stub whisper-server: GET / health, POST /inference -> fixed transcript.
function startStub(replyText) {
  const seen = { contentType: "", bodyBytes: 0, posts: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") { res.writeHead(200); res.end("ok"); return; }
    if (req.method === "POST" && req.url === "/inference") {
      seen.posts++;
      seen.contentType = String(req.headers["content-type"] || "");
      const chunks = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        seen.bodyBytes = Buffer.concat(chunks).length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: replyText, language: "en", confidence: 0.9 }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` });
    });
  });
}

// [1] Real whisper-server protocol over HTTP (stub = LIVE PROVIDER VERIFIED locally).
async function t1() {
  console.log("\n[1] Whisper-server protocol (WAV post -> transcript)");
  const { srv, seen, url } = await startStub("tell me about your kubernetes experience");
  try {
    const p = new WhisperServerProvider({ endpoint: url, timeoutMs: 5000 });
    await p.init();
    assert(p.isReady() === true, "health check marks provider ready");
    const st = p.getStatus();
    assert(st.state === "CONNECTED" && st.configured && st.endpoint === url, "status CONNECTED with endpoint");
    const fin = await p.transcribe({ pcm: sinePcm(8000, 440, 16000, 0.4), sampleRate: 16000, partial: false });
    assert(fin.text === "tell me about your kubernetes experience" && fin.isFinal === true, "final transcript text + flag");
    const part = await p.transcribe({ pcm: sinePcm(8000, 440, 16000, 0.4), sampleRate: 16000, partial: true });
    assert(part.isFinal === false, "partial request maps to isFinal=false");
    assert(seen.contentType === "audio/wav", "WAV content-type posted (got " + seen.contentType + ")");
    assert(seen.bodyBytes > 44, "WAV header + samples posted (" + seen.bodyBytes + "B)");
    await p.shutdown();
  } finally {
    srv.close();
  }
}

// [2] Restart no longer kills STT (Start -> Stop -> Start keeps working).
async function t2() {
  console.log("\n[2] STT survives stop/start (restart-death fix)");
  const { srv, url } = await startStub("hello interview");
  try {
    const p = new WhisperServerProvider({ endpoint: url, timeoutMs: 5000 });
    await p.init();
    await p.shutdown();
    assert(p.isReady() === true, "shutdown() no longer clears server reachability");
    const mgr = new TranscriptionManager(p);
    await mgr.init();
    mgr.start();
    const events = [];
    mgr.on("transcript", (e) => events.push(e));
    for (let i = 0; i < 5; i++) { mgr.feed("microphone", sinePcm(8000, 440, 16000, 0.4)); await sleep(60); }
    for (let i = 0; i < 10; i++) { mgr.feed("microphone", silence(4000)); await sleep(80); }
    await sleep(2000);
    assert(events.length >= 1, "first session transcribes (" + events.length + " events)");
    mgr.stop();
    assert(p.isReady() === true, "provider still ready after manager stop()");
    mgr.start();
    const events2 = [];
    mgr.on("transcript", (e) => events2.push(e));
    for (let i = 0; i < 5; i++) { mgr.feed("microphone", sinePcm(8000, 500, 16000, 0.4)); await sleep(60); }
    for (let i = 0; i < 10; i++) { mgr.feed("microphone", silence(4000)); await sleep(80); }
    await sleep(2000);
    assert(events2.length >= 1, "second session transcribes after restart (no zombie silence)");
    mgr.stop();
  } finally {
    srv.close();
  }
}

// [3] Failure honesty: dead server -> DISCONNECTED + reason, mock stays labeled.
async function t3() {
  console.log("\n[3] STT failure honesty (no silent fake transcripts)");
  const dead = new WhisperServerProvider({ endpoint: "http://127.0.0.1:9", timeoutMs: 1500 });
  await dead.init();
  assert(dead.isReady() === false, "unreachable server is not ready");
  const st = dead.getStatus();
  assert(st.state === "DISCONNECTED" && st.lastError.length > 0, "DISCONNECTED with reason (" + st.lastError.slice(0, 60) + ")");
  const r = await dead.transcribe({ pcm: sinePcm(8000, 440, 16000, 0.4), sampleRate: 16000, partial: false });
  assert(r.text.indexOf("[mock transcription") === 0, "fallback stays mock-LABELED (never a fake real transcript)");
  // Was-ready then server dies mid-run.
  const live = await startStub("x");
  try {
    const p2 = new WhisperServerProvider({ endpoint: live.url, timeoutMs: 2000 });
    await p2.init();
    assert(p2.isReady() === true, "stub ready");
    live.srv.close();
    await sleep(100);
    await p2.transcribe({ pcm: sinePcm(8000, 440, 16000, 0.4), sampleRate: 16000, partial: false });
    assert(p2.isReady() === false && p2.getStatus().lastError.length > 0, "mid-run failure flips to DISCONNECTED with reason");
  } catch (e) {
    assert(false, "mid-run failure path threw: " + String(e).slice(0, 100));
  }
}

// [4] Secret hygiene: keys never appear in status/diagnostics surface.
async function t4() {
  console.log("\n[4] No secrets in STT status");
  const g = new GroqWhisperProvider({ apiKey: "SECRET-XYZ-123", endpoint: "https://api.groq.example", model: "whisper-large-v3", timeoutMs: 1000 });
  await g.init();
  const dump = JSON.stringify(g.getStatus());
  assert(dump.indexOf("SECRET-XYZ-123") === -1, "API key absent from status payload");
  assert(g.getStatus().state === "CONNECTED", "keyed groq reports CONNECTED (reachability proven only on first transcribe)");
  const g2 = new GroqWhisperProvider({ apiKey: "", endpoint: "https://api.groq.example", model: "m", timeoutMs: 1000 });
  await g2.init();
  assert(g2.getStatus().state === "ERROR" && /api.?key/i.test(g2.getStatus().lastError), "missing key is ERROR with reason");
  await g2.shutdown();
  assert(g2.isReady() === false, "keyless stays not-ready after shutdown (no fake flip)");
}

// [5] Question detection across the required cases.
function t5() {
  console.log("\n[5] Question detection cases");
  const qd = new QuestionDetector();
  const cases = [
    ["Tell me about a difficult project you worked on.", true, "behavioral"],
    ["What is the difference between a process and a thread?", true, "technical"],
    ["How would you optimize this algorithm?", true, "coding"],
    ["How would you design a URL shortener?", true, "system_design"],
    ["Can you explain that part in more detail?", true, "follow_up"],
  ];
  for (const [text, wantQ, wantType] of cases) {
    const c = qd.classify(text);
    assert(c.isQuestion === wantQ && c.type === wantType, `"${text.slice(0, 42)}..." -> ${c.type} (want ${wantType})`);
  }
  const neg = qd.classify("Okay, thanks.");
  assert(neg.isQuestion === false, "'Okay, thanks.' triggers NO answer (reason=" + neg.reason + ")");
}

// [6] Grounding: missing facts are never injected as experience.
function t6() {
  console.log("\n[6] Grounding (Kubernetes acceptance test)");
  const profile = emptyProfile("Test Candidate");
  addVerifiedFact(profile, { text: "Skill: React", category: "skill", source: "resume" });
  addVerifiedFact(profile, { text: "Skill: TypeScript", category: "skill", source: "resume" });
  addVerifiedFact(profile, { text: "Skill: PostgreSQL", category: "skill", source: "resume" });
  addVerifiedFact(profile, { text: "Project: Payments API with PostgreSQL query optimization", category: "project", source: "resume" });
  const prompt = buildAnswerPrompt({
    question: "Tell me about your Kubernetes experience.",
    questionType: "technical",
    recentContext: [],
    screenEvents: [],
    profile,
    candidateMode: "real",
  });
  const kCount = (prompt.match(/kubernetes/gi) || []).length;
  assert(kCount === 1, "Kubernetes appears only in the question, never as a fact (count=" + kCount + ")");
  assert(/do NOT invent/i.test(prompt), "anti-invention grounding rules present in prompt");
  assert(/React/.test(prompt), "relevant verified facts still included");
  const rel = selectRelevantContext("Tell me about a database optimization problem.", "technical", profile, null);
  const joined = JSON.stringify(rel.facts) + JSON.stringify(rel.projects);
  assert(/postgres/i.test(joined), "database question prioritizes database facts");
  assert(rel.facts.length <= profile.verifiedFacts.length, "relevance selects a subset, not a dump");
}

async function main() {
  console.log("Intervia end-to-end pipeline suite (stub-server STT + detection + grounding)");
  await t1(); await t2(); await t3(); await t4(); t5(); t6();
  console.log("\n=================================");
  console.log(`PIPELINE SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL PIPELINE TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
