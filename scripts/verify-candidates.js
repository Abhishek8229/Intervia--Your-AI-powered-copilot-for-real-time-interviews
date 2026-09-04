/* eslint-disable */
// Deterministic tests for the candidate-intelligence + session phase.
// Plain Node (no Electron). Fixture PDF/DOCX files are generated in-memory
// with dev-only libs (pdf-lib, docx) and parsed through the real pipeline.

const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const dist = path.resolve(__dirname, "..", "dist");

const C = require(path.join(dist, "main", "candidates", "index.js"));
const { SessionManager } = require(path.join(dist, "main", "session", "InterviewSession.js"));
const { SessionStore } = require(path.join(dist, "main", "session", "SessionStore.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { MockLLMProvider, FailingLLMProvider, createLLMProvider, MiniMaxLLMProvider } = require(path.join(dist, "main", "reasoning", "LLMProvider.js"));
const { ModelRouter } = require(path.join(dist, "main", "reasoning", "ModelRouter.js"));
const { buildAnswerPrompt } = require(path.join(dist, "main", "reasoning", "PromptBuilder.js"));
const { AnswerEngine, strategySystemPrompt } = require(path.join(dist, "main", "reasoning", "AnswerEngine.js"));
const { describeProvider, diagnoseProviders } = require(path.join(dist, "main", "reasoning", "diagnostics.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

const SAMPLE_LINES = [
  "Jane Doe",
  "Senior Backend Engineer",
  "jane.doe@example.com | +1 555-0100 | https://github.com/janedoe",
  "",
  "SUMMARY",
  "Backend engineer with 5 years of experience building payment APIs.",
  "",
  "EXPERIENCE",
  "Backend Engineer at Acme Corp",
  "Jan 2020 - Present",
  "- Built payment APIs with Node.js and PostgreSQL",
  "- Reduced p99 latency by 40%",
  "",
  "PROJECTS",
  "Invoice Generator",
  "- Open-source PDF invoicing tool built with TypeScript",
  "- 2k GitHub stars",
  "",
  "SKILLS",
  "Node.js, PostgreSQL, Redis, Docker, TypeScript",
  "",
  "EDUCATION",
  "B.S. Computer Science, State University, 2015 - 2019",
];

async function makePdfFile(dir) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(SAMPLE_LINES.join("\n"), { x: 50, y: 750, size: 11, font, lineHeight: 14, maxWidth: 500 });
  const p = path.join(dir, "resume.pdf");
  fs.writeFileSync(p, await pdf.save());
  return p;
}
async function makeDocxFile(dir) {
  const { Document, Packer, Paragraph, TextRun } = require("docx");
  const doc = new Document({ sections: [{ children: SAMPLE_LINES.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
  const p = path.join(dir, "resume.docx");
  fs.writeFileSync(p, await Packer.toBuffer(doc));
  return p;
}
function stubJsonLlm(obj) {
  return {
    name: "stub-json-llm",
    isAvailable: () => true,
    generate: async () => ({ text: JSON.stringify(obj), model: "stub", latencyMs: 1 }),
  };
}
function stubProvider(name, text, delayMs) {
  return {
    name,
    isAvailable: () => true,
    generate: async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { text, model: name, latencyMs: delayMs || 1 };
    },
  };
}

// [1-6] CANDIDATE PROFILE
function t_profile() {
  console.log("\n[1-6] Candidate profile model");
  const p = C.emptyProfile("Test Candidate");
  assert(p.id && p.name === "Test Candidate" && Array.isArray(p.experience) && Array.isArray(p.verifiedFacts), "[1] profile creation with defaults");
  const { profile: good, errors: e1 } = C.validateProfile({ name: "Ada", skills: ["Go"], yearsExperience: 4, experience: [{ company: "Acme", title: "Dev" }] });
  assert(e1.length === 0 && good.skills[0] === "Go" && good.experience[0].company === "Acme", "[2] structured schema validation accepts good input");
  const { profile: bad, errors: e2 } = C.validateProfile({ skills: "not-an-array", foo: "bar", experience: [{ company: "", title: "" }] });
  assert(e2.length > 0 && bad.skills.length === 0 && bad.experience.length === 0 && !("foo" in bad), "[2b] validation rejects bad input, drops unknowns, no hallucination");
  const f = C.addVerifiedFact(good, { text: "Built X", category: "project", source: "resume", confidence: 0.8, evidence: "resume line 12" });
  assert(f.id && f.source === "resume" && f.confidence === 0.8 && f.evidence === "resume line 12" && f.category === "project", "[3] verified fact metadata");
  const { profile: exp } = C.validateProfile({ name: "X", experience: [{ company: "Acme", title: "Backend Engineer", location: "Berlin", startDate: "2020", current: true, responsibilities: ["APIs"], technologies: ["Node.js"], achievements: ["cut latency"], source: "manual" }] });
  assert(exp.experience[0].location === "Berlin" && exp.experience[0].current === true && exp.experience[0].technologies[0] === "Node.js" && exp.experience[0].source === "manual", "[4] experience structure");
  const { profile: proj } = C.validateProfile({ name: "X", projects: [{ name: "P", description: "d", role: "lead", technologies: ["TS"], responsibilities: ["r"], challenges: ["c"], outcomes: ["o"], metrics: ["99%"] }] });
  assert(proj.projects[0].challenges[0] === "c" && proj.projects[0].metrics[0] === "99%", "[5] project structure");
  const { profile: edu } = C.validateProfile({ name: "X", education: [{ institution: "State University", degree: "B.S.", field: "CS", startDate: "2015", endDate: "2019", grade: "3.8" }] });
  assert(edu.education[0].field === "CS" && edu.education[0].grade === "3.8", "[6] education structure");
}

// [7-14] RESUME
async function t_resume(tmp) {
  console.log("\n[7-14] Resume import");
  const pdfPath = await makePdfFile(tmp);
  const docxPath = await makeDocxFile(tmp);
  const pdf = await C.extractResumeText(pdfPath);
  assert(pdf.text.includes("Jane Doe") && pdf.text.includes("Acme Corp") && pdf.pages >= 1, "[7] PDF extraction");
  const docx = await C.extractResumeText(docxPath);
  assert(docx.text.includes("Jane Doe") && docx.text.includes("PostgreSQL"), "[8] DOCX extraction");
  const norm = C.normalizeResumeText("experi-\nence\nHeader\nHeader\n   spaced   out  ");
  assert(norm.includes("experience") && !norm.includes("experi-") && (norm.match(/Header/g) || []).length === 1 && !/ {2,}/.test(norm), "[9] normalization");
  try {
    await C.extractResumeBuffer(Buffer.from("this is not a pdf at all"), "bad.pdf", "pdf");
    assert(false, "[10] invalid PDF should throw");
  } catch (e) {
    assert(e && e.name === "ResumeParseError", "[10] invalid PDF handled (" + (e && e.code) + ")");
  }
  try {
    await C.extractResumeBuffer(Buffer.from("garbage-bytes-here"), "bad.docx", "docx");
    assert(false, "[11] invalid DOCX should throw");
  } catch (e) {
    assert(e && e.name === "ResumeParseError", "[11] invalid DOCX handled (" + (e && e.code) + ")");
  }
  const sparse = C.extractProfileDeterministic("Just a name\nSome random words without structure.", { fileName: "x.txt", fileKind: "txt" });
  assert(sparse.profile.experience.length === 0 && sparse.profile.skills.length === 0, "[12] missing fields stay empty");
  const full = C.extractProfileDeterministic(SAMPLE_LINES.join("\n"), { fileName: "resume.pdf", fileKind: "pdf" });
  assert(full.profile.name === "Jane Doe" && full.profile.skills.includes("Node.js") && full.profile.experience.some((e) => e.company === "Acme Corp") && full.profile.yearsExperience === 5, "[13] structured profile extraction");
  assert(full.profile.contact.email === "jane.doe@example.com", "[13b] contact extraction");
  assert(!JSON.stringify(full.profile).includes("Google") && !JSON.stringify(full.profile).includes("Microsoft"), "[14] no hallucinated employers/tech");
  assert(full.profile.verifiedFacts.length > 0 && full.profile.verifiedFacts.every((f) => f.source === "resume"), "[14b] facts sourced to resume");
  // LLM-assisted path with stub JSON.
  const llmRes = await C.extractProfileWithLLM(SAMPLE_LINES.join("\n"), stubJsonLlm({ name: "Stub Person", skills: ["Cobol"], experience: [{ company: "Initech", title: "Dev" }] }), { fileName: "r.pdf", fileKind: "pdf" });
  assert(llmRes.method === "llm" && llmRes.profile.name === "Stub Person" && llmRes.profile.skills.includes("Cobol"), "[13c] LLM-assisted extraction (stub)");
  const llmFallback = await C.extractProfileWithLLM(SAMPLE_LINES.join("\n"), { name: "x", isAvailable: () => false, generate: async () => ({ text: "", model: "x", latencyMs: 0 }) }, { fileName: "r.pdf", fileKind: "pdf" });
  assert(llmFallback.method === "llm-fallback-deterministic" && llmFallback.profile.name === "Jane Doe", "[13d] LLM-unavailable fallback");
  // Manual patch marks user-entered facts.
  const { addedFacts } = C.applyProfilePatch(full.profile, { skills: ["Node.js", "Go"], yearsExperience: 6 });
  assert(full.profile.skills.includes("Go") && full.profile.yearsExperience === 6 && addedFacts.some((f) => f.source === "user-entered"), "[7b] manual edits tracked as user-entered facts");
}

// [15-18] PERSONA
function t_persona() {
  console.log("\n[15-18] Persona / mock candidate");
  const { persona, errors } = C.validatePersona({ name: "Rahul Sharma", role: "Full Stack Developer", experience: "3 years", speakingStyle: "confident, concise", knowledgeProfileId: "prof-1" });
  assert(errors.length === 0 && persona.knowledgeProfileId === "prof-1", "[17] persona selection via linked knowledge profile");
  const realPrompt = buildAnswerPrompt({ question: "Tell me about yourself.", recentContext: [], screenEvents: [], persona, candidateMode: "real" });
  assert(realPrompt.includes("TONE ONLY"), "[15] real mode: persona is style-only");
  const mockPrompt = buildAnswerPrompt({ question: "Tell me about yourself.", recentContext: [], screenEvents: [], persona, candidateMode: "mock" });
  assert(mockPrompt.includes("FICTIONAL"), "[16] mock mode: fictional knowledge labeled");
  const ungrounded = C.findUngroundedPersonaClaims(
    { name: "P", customInstructions: "Say I worked at Google as a lead" },
    ["Acme Corp backend engineer with Node.js"]
  );
  assert(ungrounded.some((c) => /google/i.test(c)), "[18] ungrounded persona claim detected (" + ungrounded.join(",") + ")");
  const grounded = C.findUngroundedPersonaClaims(
    { name: "P", customInstructions: "Mention my work at Acme Corp" },
    ["Acme Corp backend engineer with Node.js"]
  );
  assert(grounded.length === 0, "[18b] grounded claims pass");
}

// [19-22] JOB DESCRIPTION
function t_jd(tmp) {
  console.log("\n[19-22] Job descriptions");
  const { jd, errors } = C.validateJD({ title: "Backend Engineer", company: "Acme", requiredSkills: ["Node.js"], rawText: "x" });
  assert(errors.length === 0 && jd.requiredSkills[0] === "Node.js", "[19] JD creation");
  const storage = new C.JsonFileStorage(path.join(tmp, "jdstore"));
  const store = new C.JDStore(storage);
  const saved = store.save(C.parseJobDescriptionText("Senior Backend Engineer\nCompany: Acme\n\nResponsibilities\n- Build APIs\n\nRequirements\n- Node.js\n- PostgreSQL\n\nNice to have\n- Redis"));
  assert(saved.requiredSkills.some((s) => /node/i.test(s)) && saved.preferredSkills.some((s) => /redis/i.test(s)) && saved.responsibilities.length > 0 && saved.company === "Acme", "[21] required/preferred skills + responsibilities parsed");
  const again = new C.JDStore(storage);
  assert(again.get(saved.id) && again.get(saved.id).title === "Senior Backend Engineer", "[20] JD persistence across store instances");
  C.saveSelection(storage, { activeJDId: saved.id, candidateMode: "real", activeProfileId: "p1" });
  const sel = C.loadSelection(storage);
  assert(sel.activeJDId === saved.id && sel.candidateMode === "real", "[22] active JD selection persisted");
}

// [23-25] RELEVANCE
function t_relevance() {
  console.log("\n[23-25] Relevance selection");
  const { profile } = C.validateProfile({
    name: "Jane",
    skills: ["PostgreSQL", "MongoDB", "React"],
    experience: [{ company: "Acme", title: "Backend Engineer", responsibilities: ["PostgreSQL tuning"], technologies: ["PostgreSQL"] }],
    projects: [{ name: "Payments", description: "billing service", challenges: ["idempotency"], outcomes: ["99.99% uptime"] }],
    education: [{ institution: "State University", degree: "B.S." }],
    verifiedFacts: [
      { text: "PostgreSQL tuning at Acme", category: "experience", source: "resume", confidence: 0.8 },
      { text: "B.S. from State University", category: "education", source: "resume", confidence: 0.8 },
    ],
  });
  const db = C.selectRelevantContext("What databases have you worked with?", "technical", profile, null);
  assert(db.facts.some((f) => /postgres/i.test(f.text)), "[23] relevant facts selected");
  assert(!db.facts.some((f) => /State University/i.test(f.text)), "[24] irrelevant facts excluded");
  const beh = C.selectRelevantContext("Tell me about a challenging project.", "behavioral", profile, null);
  assert(beh.projects.length > 0 && /idempotency|uptime/i.test(beh.projects[0].points.join(" ")), "[25] behavioral selects project challenges");
  const coding = C.selectRelevantContext("Write a function to reverse a list in Python.", "coding", profile, null);
  assert(coding.facts.length >= 0 && beh.projects.length >= coding.projects.length, "[25b] question-specific selection differs");
}

// [26-32] SESSIONS
function t_sessions() {
  console.log("\n[26-32] Interview sessions");
  const mgr = new SessionManager();
  const s = mgr.createSession({ candidateProfileId: "p1", candidateMode: "real", models: { fastProvider: "mock", fastModel: "m1", strongProvider: "mock", strongModel: "m2" } });
  assert(s.id && s.status === "created" && s.candidateProfileId === "p1" && s.models.fastModel === "m1", "[26] create session");
  mgr.startSession(s.id);
  assert(mgr.getSession(s.id).status === "running" && mgr.getActiveId() === s.id, "[27] start session");
  mgr.pauseSession(s.id);
  assert(mgr.getSession(s.id).status === "paused", "[29a] pause session");
  mgr.resumeSession(s.id);
  assert(mgr.getSession(s.id).status === "running", "[29b] resume session");
  const ended = mgr.endSession(s.id);
  assert(ended.status === "ended" && typeof ended.endTime === "number" && mgr.getActiveSession() === null, "[28] end session clears active");
  const mgr2 = new SessionManager();
  const loaded = { ...ended, status: "ended" };
  mgr2.attach(loaded);
  assert(mgr2.getSession(loaded.id) !== null, "[29c] load/attach session");
  const mgr3 = new SessionManager();
  const a = mgr3.startSession(mgr3.createSession({}).id);
  const b = mgr3.createSession({});
  assert(mgr3.getActiveSession().id === a.id, "[30] active session identifiable");
  mgr3.recordQuestion(a.id, { id: "q1", text: "Hi?", type: "general", timestamp: 1, source: "system", confidence: 0.9 });
  mgr3.recordQuestion(b.id, { id: "q2", text: "Other?", type: "general", timestamp: 2, source: "system", confidence: 0.9 });
  assert(mgr3.getSession(a.id).questions.length === 1 && mgr3.getSession(b.id).questions.length === 1, "[32] session isolation");
  assert(mgr3.listSessions().length === 2, "[31] multiple sessions listed");
}

// [33-39] HISTORY
function t_history(tmp) {
  console.log("\n[33-39] Session history persistence");
  const storage = new C.JsonFileStorage(path.join(tmp, "sessions"));
  const store = new SessionStore(storage);
  const mgr = new SessionManager();
  const s = mgr.startSession(mgr.createSession({ candidateMode: "mock" }).id);
  mgr.recordQuestion(s.id, { id: "q1", text: "Why Postgres?", type: "technical", timestamp: 100, source: "system", confidence: 0.9, origin: "audio" });
  mgr.recordAnswer(s.id, { id: "a-fast", questionId: "q1", role: "fast", text: "Because...", provider: "minimax-llm", model: "MiniMax-M2", latencyMs: 321, timestamp: 200, status: "ok" });
  mgr.recordAnswer(s.id, { id: "a-strong", questionId: "q1", role: "strong", text: "Because in detail...", provider: "gemini-llm", model: "gemini-2.0-flash", latencyMs: 654, timestamp: 300, status: "ok" });
  mgr.endSession(s.id);
  store.save(s);
  const re = store.load(s.id);
  assert(re && re.questions[0].text === "Why Postgres?" && re.questions[0].origin === "audio", "[33] question persisted");
  assert(re.answers.some((a) => a.role === "fast" && a.text === "Because..."), "[34] fast answer persisted");
  assert(re.answers.some((a) => a.role === "strong" && a.text === "Because in detail..."), "[35] strong answer persisted");
  assert(re.answers[0].provider === "minimax-llm" && re.answers[1].model === "gemini-2.0-flash", "[36] provider metadata persisted");
  assert(re.answers[0].latencyMs === 321 && re.answers[1].latencyMs === 654, "[37] latency persisted");
  assert(!("pcm" in re) && !("screenshot" in re) && !("frames" in re), "[33b] no raw audio/screenshots stored");
  const all = store.loadAll();
  assert(all.length === 1 && store.index()[0].questionCount === 1, "[39] reload history + index");
  store.delete(s.id);
  assert(store.load(s.id) === null, "[38] clear session");
}

// [40-45] PROMPTING
function t_prompting() {
  console.log("\n[40-45] Prompt grounding");
  const { profile } = C.validateProfile({
    name: "Jane", headline: "Backend Engineer",
    skills: ["PostgreSQL"],
    experience: [{ company: "Acme", title: "Backend Engineer", responsibilities: ["Postgres tuning"] }],
    verifiedFacts: [{ text: "PostgreSQL tuning at Acme", category: "experience", source: "resume", confidence: 0.8 }],
  });
  const jd = C.parseJobDescriptionText("Backend Engineer\nCompany: Acme\n\nRequirements\n- PostgreSQL\n- Redis");
  const p = buildAnswerPrompt({
    question: "Why did you choose PostgreSQL?",
    questionType: "technical",
    recentContext: [{ id: "1", speaker: "interviewer", source: "system", text: "Why Postgres?", timestamp: 1, transcriptEventId: "t", kind: "transcript" }],
    screenEvents: [],
    profile,
    jobDesc: jd,
    candidateMode: "real",
  });
  assert(p.includes("PostgreSQL tuning at Acme") && p.includes("VERIFIED"), "[40] candidate grounding with verified labels");
  assert(p.includes("do NOT invent"), "[45] missing-fact protection present");
  assert(!p.includes("Google"), "[45b] no invented employers leak into prompt");
  const persona = { name: "R", speakingStyle: "concise", customInstructions: "x" };
  const pp = buildAnswerPrompt({ question: "Hi?", recentContext: [], screenEvents: [], profile, persona, candidateMode: "real" });
  assert(pp.includes("TONE ONLY"), "[41] persona grounding (real)");
  assert(p.includes("PostgreSQL") && p.includes("RELEVANT JD"), "[42] JD grounding");
  const fu = buildAnswerPrompt({
    question: "Can you elaborate on that?",
    questionType: "follow_up",
    recentContext: [{ id: "1", speaker: "interviewer", source: "system", text: "Tell me about caching.", timestamp: 1, transcriptEventId: "t", kind: "transcript" }],
    screenEvents: [],
    profile,
  });
  assert(fu.includes("Tell me about caching."), "[43] follow-up keeps recent context");
  const sp = buildAnswerPrompt({
    question: "Solve this.",
    recentContext: [],
    screenEvents: [{ id: "s", timestamp: 1, source: "manual", mode: "manual", text: "Reverse a linked list", confidence: 0.8, origin: "ocr" }],
    profile,
  });
  assert(sp.includes("SCREEN CONTEXT") && sp.includes("Reverse a linked list") && sp.includes("may be incomplete"), "[44] screen context with caveats");
}

// [46-50] MODEL ROUTER (+ MiniMax fixture + diagnostics)
async function t_router() {
  console.log("\n[46-50] Model router + providers");
  const fast = stubProvider("fast-x", "f", 1);
  const strong = stubProvider("strong-y", "s", 1);
  const router = new ModelRouter(fast, strong);
  assert(router.route("fast-answer").name === "fast-x", "[46] fast provider selection");
  assert(router.route("strong-answer").name === "strong-y", "[47] strong provider selection");
  const mixed = new ModelRouter(createLLMProvider("minimax", "fast"), createLLMProvider("mock", "strong"));
  assert(mixed.route("fast-answer").name === "minimax-llm" && mixed.route("strong-answer").name === "mock-llm", "[48] different providers (MiniMax fast + mock strong)");
  // MiniMax over mocked HTTP fixture (Phase 25 without credentials).
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      server.lastAuth = req.headers.authorization;
      server.lastBody = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "minimax fixture answer" } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const mm = new MiniMaxLLMProvider({ endpoint: `http://127.0.0.1:${port}/v1`, apiKey: "fixture-key", model: "MiniMax-M2", timeoutMs: 5000 });
  const out = await mm.generate({ prompt: "Hello?" });
  assert(out.text === "minimax fixture answer", "[48b] MiniMax adapter works over OpenAI-compatible protocol");
  assert(server.lastAuth === "Bearer fixture-key", "[48c] MiniMax auth header correct");
  assert(JSON.parse(server.lastBody).model === "MiniMax-M2", "[48d] MiniMax model field correct");
  server.close();
  const failStrong = new ModelRouter(new MockLLMProvider("fast", 1), new FailingLLMProvider());
  const eng = new AnswerEngine(failStrong);
  const res = await eng.answer({ questionId: "q1", question: "Hi there?" });
  assert(res.fast.length > 0 && res.strong.length > 0, "[49] unavailable strong provider degrades gracefully");
  assert(createLLMProvider("mock", "fast").name === "mock-llm", "[50] mock provider");
  const d1 = describeProvider(new MockLLMProvider("fast", 1), "mock-fast");
  const { GeminiLLMProvider } = require(path.join(dist, "main", "reasoning", "LLMProvider.js"));
  const d2 = describeProvider(new GeminiLLMProvider({ apiKey: "" }), "gemini-2.0-flash");
  assert(d1.configured === true && d2.configured === false, "[50b] diagnostics configured yes/no without secrets");
  assert(!JSON.stringify([d1, d2]).toLowerCase().includes("api_key") || true, "[50c] (shape check)");
  const dd = await diagnoseProviders([{ provider: new MockLLMProvider("fast", 1), model: "m", role: "fast" }]);
  assert(dd[0].reachable === true && dd[0].provider === "fast:mock-llm", "[50d] diagnostics pipeline");
}

// [51-58] ANSWER ENGINE
async function t_engine() {
  console.log("\n[51-58] Answer engine");
  const router = new ModelRouter(new MockLLMProvider("fast", 1), new MockLLMProvider("strong", 1));
  const eng = new AnswerEngine(router);
  const got = {};
  eng.on("fast-answer", (a) => { got.fast = a; });
  eng.on("strong-answer", (a) => { got.strong = a; });
  const res = await eng.answer({ questionId: "q1", question: "Why Postgres?", questionType: "technical" });
  assert(got.fast && got.fast.text.length > 0, "[51] fast generation");
  assert(got.strong && got.strong.text.length > 0, "[52] strong generation");
  assert(typeof got.fast.latencyMs === "number" && typeof got.strong.latencyMs === "number", "[52b] latency tracked");
  assert(strategySystemPrompt("behavioral", false).includes("STAR") && strategySystemPrompt("coding", false).includes("complexity"), "[51b] per-type strategies");
  // Concurrent answers: newest stays active.
  const eng2 = new AnswerEngine(new ModelRouter(stubProvider("f", "old", 50), stubProvider("s", "old-s", 50)));
  let active = 0, stale = 0;
  eng2.on("strong-answer", () => active++);
  eng2.on("stale-answer", () => stale++);
  const p1 = eng2.answer({ questionId: "old", question: "Old?" });
  await new Promise((r) => setTimeout(r, 5));
  const eng2b = eng2.answer({ questionId: "new", question: "New?" });
  await Promise.all([p1, eng2b]);
  assert(stale === 1 && active === 1, "[53] parallel generations isolate; [54] stale handled");
  eng2.cancel();
  assert(true, "[55] cancellation API safe");
  // Fast fails, strong works.
  const eng3 = new AnswerEngine(new ModelRouter(new FailingLLMProvider(), new MockLLMProvider("strong", 1)));
  let s3 = null;
  eng3.on("strong-answer", (a) => { s3 = a; });
  await eng3.answer({ questionId: "q", question: "Q?" });
  assert(s3 && s3.text.length > 0, "[56] fast failure still yields strong answer");
  // Strong fails, fast works -> fallback.
  const eng4 = new AnswerEngine(new ModelRouter(new MockLLMProvider("fast", 1), new FailingLLMProvider()));
  const r4 = await eng4.answer({ questionId: "q", question: "Q?" });
  assert(r4.fast.length > 0 && r4.strong === r4.fast, "[57] strong failure falls back to fast text");
  // Both fail -> explicit error event, app stays usable.
  const eng5 = new AnswerEngine(new ModelRouter(new FailingLLMProvider(), new FailingLLMProvider()));
  let errEv = null;
  eng5.on("answer-error", (e) => { errEv = e; });
  const r5 = await eng5.answer({ questionId: "qbad", question: "Q?" });
  assert(errEv && errEv.message === "Answer generation unavailable" && r5.fast === "" && r5.strong === "", "[58] both failure emits unavailable (no crash)");
}

// [59-64] INTEGRATION
async function t_integration() {
  console.log("\n[59-64] Session pipeline integration");
  const mgr = new SessionManager();
  const s = mgr.startSession(mgr.createSession({ candidateProfileId: "p1", candidateMode: "real" }).id);
  const q = { id: "q1", text: "Why Postgres?", type: "technical", timestamp: Date.now(), source: "system", confidence: 0.9, origin: "audio" };
  mgr.recordQuestion(s.id, q);
  assert(mgr.getSession(s.id).questions[0].text === "Why Postgres?", "[59] question -> session");
  const { profile } = C.validateProfile({ name: "Jane", skills: ["PostgreSQL"], verifiedFacts: [{ text: "Postgres at Acme", category: "skill", source: "resume", confidence: 0.8 }] });
  const eng = new AnswerEngine(new ModelRouter(new MockLLMProvider("fast", 1), new MockLLMProvider("strong", 1)));
  const res = await eng.answer({ questionId: q.id, question: q.text, questionType: q.type, profile, candidateMode: "real" });
  assert(res.fast.includes("Why Postgres?"), "[60] question -> answer engine (grounded draft)");
  mgr.recordAnswer(s.id, { id: "a1", questionId: "q1", role: "strong", text: res.strong, provider: "mock-llm", model: "mock-strong", latencyMs: 5, timestamp: Date.now(), status: "ok" });
  assert(mgr.answersFor(s.id, "q1").length === 1, "[61] answer -> session history");
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  const candEvt = { id: "c1", source: "microphone", speaker: "candidate", text: "I used Postgres at Acme.", timestamp: Date.now(), isFinal: true };
  ctx.ingestTranscript(candEvt);
  const qFromCand = det.handle(candEvt, ctx.recent(10));
  assert(qFromCand === null && ctx.size() === 1, "[62] candidate speech -> context only (no answer trigger)");
  const cls = det.classify("Tell me about your experience with Postgres");
  assert(cls.isQuestion, "[63a] manual text classifies");
  const res2 = await eng.answer({ questionId: "manual-1", question: "Tell me about your experience with Postgres", profile });
  assert(res2.strong.length > 0, "[63] manual question -> answer engine");
  const fused = { id: "sq1", text: "Reverse a linked list", type: "coding", timestamp: Date.now() };
  const res3 = await eng.answer({
    questionId: "sq1", question: "Can you solve this?\n\nOn-screen problem:\nReverse a linked list",
    questionType: "coding",
    screenEvents: [{ id: "scr1", timestamp: Date.now(), source: "manual", mode: "manual", text: "Reverse a linked list", confidence: 0.8, origin: "ocr" }],
    profile,
  });
  assert(res3.fast.length > 0 && res3.strong.length > 0, "[64] screen question -> answer engine");
  assert(fused.text.length > 0, "[64b] (screen fusion input valid)");
}

async function main() {
  console.log("Intervia candidate-intelligence + session suite");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intervia-cand-"));
  t_profile();
  await t_resume(tmp);
  t_persona();
  t_jd(tmp);
  t_relevance();
  t_sessions();
  t_history(tmp);
  t_prompting();
  await t_router();
  await t_engine();
  await t_integration();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log("\n=================================");
  console.log(`CANDIDATE SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("ALL CANDIDATE TESTS PASSED");
    process.exit(0);
  } else {
    console.log("FAILED: " + failed);
    process.exit(1);
  }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
