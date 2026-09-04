/* eslint-disable */
// Deterministic unit + integration tests for the conversation layer.
// Uses Node directly (no Electron). Loads compiled modules from dist/.

const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { SpeakerAttributor } = require(path.join(dist, "main", "conversation", "SpeakerAttributor.js"));
const { InterviewContext } = require(path.join(dist, "main", "conversation", "InterviewContext.js"));
const { QuestionDetector, normalizeQuestionText, tokenSimilarity } = require(path.join(dist, "main", "conversation", "QuestionDetector.js"));
const { TranscriptionManager } = require(path.join(dist, "main", "transcription", "TranscriptionManager.js"));
const { createProvider } = require(path.join(dist, "main", "transcription", "providers", "index.js"));

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log("  PASS " + msg);
  else { console.log("  FAIL " + msg); failed++; }
}

function evt(id, source, speaker, text, isFinal, ts) {
  return { id, source, speaker, text, timestamp: ts, isFinal };
}

function classify(detector, text) {
  return detector.classify(text);
}

async function test1_mic_is_candidate() {
  console.log("\n[1] Microphone transcript speaker = candidate");
  const mgr = new TranscriptionManager(undefined, { attributeSpeaker: (s) => s === "microphone" ? "candidate" : "interviewer" });
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));
  // Feed microphone sine wave for 800ms, then 1200ms silence so VAD fires end.
  const noisy = new Int16Array(16000 * 0.8);
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.round(Math.sin((2*Math.PI*440*i/16000))*0.4*32767);
  const quiet = new Int16Array(16000 * 1.2);
  mgr.feed("microphone", noisy);
  for (let i = 0; i < 15; i++) {
    mgr.feed("microphone", quiet);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  mgr.stop();
  assert(events.length >= 1, "at least one transcript event");
  if (events.length) {
    const final = events.find((e) => e.isFinal) || events[events.length - 1];
    assert(final.speaker === "candidate", "final mic event has speaker=candidate");
  }
}

async function test2_system_is_interviewer() {
  console.log("\n[2] System transcript speaker = interviewer");
  const mgr = new TranscriptionManager(undefined, { attributeSpeaker: (s) => s === "microphone" ? "candidate" : "interviewer" });
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));
  const noisy = new Int16Array(16000 * 0.8);
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.round(Math.sin((2*Math.PI*440*i/16000))*0.4*32767);
  const quiet = new Int16Array(16000 * 1.2);
  mgr.feed("system", noisy);
  for (let i = 0; i < 15; i++) {
    mgr.feed("system", quiet);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  mgr.stop();
  assert(events.length >= 1, "at least one transcript event");
  if (events.length) {
    const final = events.find((e) => e.isFinal) || events[events.length - 1];
    assert(final.speaker === "interviewer", "final system event has speaker=interviewer");
  }
}

function test3_partial_no_duplicate() {
  console.log("\n[3] Partial does not create permanent duplicates");
  const ctx = new InterviewContext();
  // Simulate: partial "Tell me about" -> partial "Tell me about your experience" -> final "Tell me about your experience with React?"
  const id = "tx-1";
  ctx.ingestTranscript(evt(id, "system", "interviewer", "Tell me about", false, 100));
  ctx.ingestTranscript(evt(id, "system", "interviewer", "Tell me about your experience", false, 200));
  ctx.ingestTranscript(evt(id, "system", "interviewer", "Tell me about your experience with React?", true, 300));
  assert(ctx.size() === 1, "context has exactly 1 entry after partial+partial+final, got " + ctx.size());
  const snap = ctx.snapshot();
  assert(snap[0].text === "Tell me about your experience with React?", "final text reflects complete utterance");
  assert(snap[0].speaker === "interviewer", "speaker preserved");
}

function test4_final_replaces_partial() {
  console.log("\n[4] Final transcript replaces/merges partial utterance");
  const ctx = new InterviewContext();
  const id = "tx-2";
  ctx.ingestTranscript(evt(id, "microphone", "candidate", "I worked on", false, 100));
  ctx.ingestTranscript(evt(id, "microphone", "candidate", "I worked on a", false, 200));
  ctx.ingestTranscript(evt(id, "microphone", "candidate", "I worked on a React", false, 300));
  ctx.ingestTranscript(evt(id, "microphone", "candidate", "I worked on a React project for two years.", true, 400));
  assert(ctx.size() === 1, "only one entry after partial rollup");
  assert(ctx.snapshot()[0].text === "I worked on a React project for two years.", "final text replaces partials");
}

function test5_direct_question_mark() {
  console.log("\n[5] Direct question with '?' is detected");
  const d = new QuestionDetector();
  const r = d.classify("How would you design a URL shortener?");
  assert(r.isQuestion, "isQuestion=true");
  assert(r.type === "system_design", "classified as system_design");
  assert(r.confidence >= 0.7, "confidence >= 0.7");
}

function test6_imperative_question() {
  console.log("\n[6] Question without '?' but with interview phrasing detected");
  const d = new QuestionDetector();
  const r = d.classify("Tell me about your experience with React");
  assert(r.isQuestion, "isQuestion=true without '?'");
  assert(r.type === "resume" || r.type === "behavioral", "classified as resume or behavioral");
}

function test7_behavioral() {
  console.log("\n[7] Behavioral question classification");
  const d = new QuestionDetector();
  const r = d.classify("Tell me about a time you had a conflict with a coworker.");
  assert(r.isQuestion, "isQuestion");
  assert(r.type === "behavioral", "type=behavioral");
}

function test8_technical() {
  console.log("\n[8] Technical question classification");
  const d = new QuestionDetector();
  const r = d.classify("What is the difference between useMemo and useCallback?");
  assert(r.isQuestion, "isQuestion");
  assert(r.type === "technical", "type=technical");
}

function test9_coding() {
  console.log("\n[9] Coding question classification");
  const d = new QuestionDetector();
  const r = d.classify("Write a Python function to find duplicates in a list.");
  assert(r.isQuestion, "isQuestion");
  assert(r.type === "coding", "type=coding");
}

function test10_system_design() {
  console.log("\n[10] System design classification");
  const d = new QuestionDetector();
  const r = d.classify("How would you design Twitter?");
  assert(r.isQuestion, "isQuestion");
  assert(r.type === "system_design", "type=system_design");
}

function test11_followup() {
  console.log("\n[11] Follow-up question detection");
  const d = new QuestionDetector();
  const r = d.classify("Can you elaborate on that?");
  assert(r.isQuestion, "isQuestion");
  assert(r.type === "follow_up" || r.type === "general", "classified as follow_up or general");
}

function test12_statement_not_question() {
  console.log("\n[12] Conversational statement not flagged as question");
  const d = new QuestionDetector();
  const samples = ["Okay.", "Sounds good.", "Yeah exactly.", "Let me explain the next part.", "Give me a second.", "Okay, so", "Interesting."];
  for (const s of samples) {
    const r = d.classify(s);
    assert(!r.isQuestion, "not a question: " + s);
  }
}

function test13_duplicate_suppressed() {
  console.log("\n[13] Duplicate question is suppressed");
  const d = new QuestionDetector();
  const ts1 = 1000;
  const q1 = d.handle(evt("tx1", "system", "interviewer", "How would you design a URL shortener?", true, ts1), []);
  assert(q1 !== null, "first question emitted");
  const q2 = d.handle(evt("tx2", "system", "interviewer", "How would you design a URL shortener?", true, ts1 + 1000), []);
  assert(q2 === null, "exact duplicate within window suppressed");
  // Slight rephrasing
  const q3 = d.handle(evt("tx3", "system", "interviewer", "How would you design a URL shortener", true, ts1 + 2000), []);
  assert(q3 === null, "near-duplicate suppressed");
  // After window expires
  const q4 = d.handle(evt("tx4", "system", "interviewer", "How would you design a URL shortener?", true, ts1 + 20000), []);
  assert(q4 !== null, "same question after dedup window emitted");
}

function test14_recent_context_attached() {
  console.log("\n[14] QuestionDetectedEvent contains recent context");
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  ctx.ingestTranscript(evt("tx-a", "system", "interviewer", "Tell me about the backend of your project.", true, 100));
  ctx.ingestTranscript(evt("tx-b", "microphone", "candidate", "I used Node.js and PostgreSQL.", true, 200));
  ctx.ingestTranscript(evt("tx-c", "system", "interviewer", "How would you scale that?", true, 300));
  const recent = ctx.recent(10);
  const questionEvent = det.handle(evt("tx-c", "system", "interviewer", "How would you scale that?", true, 300), recent);
  assert(questionEvent !== null, "question emitted");
  assert(Array.isArray(questionEvent.recentContext), "recentContext is array");
  assert(questionEvent.recentContext.length >= 2, "context contains prior utterances, got " + questionEvent.recentContext.length);
  const speakers = questionEvent.recentContext.map((e) => e.speaker);
  assert(speakers.includes("interviewer") && speakers.includes("candidate"), "context has both speakers");
}

async function test15_context_bounded() {
  console.log("\n[15] Context remains bounded");
  const ctx = new InterviewContext({ maxEntries: 5, maxAgeMs: 1000, evictionIntervalMs: 50 });
  ctx.start();
  for (let i = 0; i < 100; i++) {
    ctx.ingestTranscript(evt("id-" + i, "system", "interviewer", "Question " + i, true, Date.now()));
  }
  assert(ctx.size() <= 5, "context size capped at maxEntries, got " + ctx.size());
  // Wait for age eviction
  await new Promise((r) => setTimeout(r, 1100));
  assert(ctx.size() === 0, "stale entries evicted by age");
  ctx.stop();
}

async function test16_existing_transcription_tests() {
  console.log("\n[16] Existing transcription pipeline still emits events");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));
  const noisy = new Int16Array(16000 * 0.8);
  for (let i = 0; i < noisy.length; i++) noisy[i] = Math.round(Math.sin((2*Math.PI*440*i/16000))*0.4*32767);
  const quiet = new Int16Array(16000 * 1.2);
  mgr.feed("microphone", noisy);
  for (let i = 0; i < 15; i++) {
    mgr.feed("microphone", quiet);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 1500));
  mgr.stop();
  assert(events.length >= 1, "transcription still emits");
  if (events.length) {
    const final = events.find((e) => e.isFinal);
    assert(final && final.isFinal === true, "final isFinal=true");
  }
}

function test17_speaker_attributor_replaceable() {
  console.log("\n[17] SpeakerAttributor is replaceable");
  const sa = new SpeakerAttributor();
  assert(sa.attribute("microphone") === "candidate", "default mic->candidate");
  assert(sa.attribute("system") === "interviewer", "default system->interviewer");
  sa.setRole("microphone", "interviewer");
  assert(sa.attribute("microphone") === "interviewer", "override mic->interviewer");
}

function test18_normalize_and_similarity() {
  console.log("\n[18] Question normalization & similarity");
  const a = "How would you design a URL shortener?";
  const b = "how would you design a url shortener";
  const c = "What is the difference between REST and GraphQL?";
  assert(normalizeQuestionText(a) === normalizeQuestionText(b), "normalize ignores case + punctuation");
  assert(tokenSimilarity(a, b) > 0.9, "high similarity a vs b");
  assert(tokenSimilarity(a, c) < 0.5, "low similarity a vs c");
}

function test20_pipeline_integration() {
  console.log("\n[20] End-to-end pipeline: partials + final -> context + question");
  const ctx = new InterviewContext();
  const det = new QuestionDetector();
  const transcriptEvents = [];
  // Simulate two interviewer turns: an opening statement (not a question), then a question.
  const idA = "tx-a";
  ctx.ingestTranscript(evt(idA, "system", "interviewer", "Okay", false, 100));
  ctx.ingestTranscript(evt(idA, "system", "interviewer", "Okay so", false, 150));
  ctx.ingestTranscript(evt(idA, "system", "interviewer", "Okay so today we are going to focus on system design", false, 200));
  // Final filler (not question)
  const finalA = evt(idA, "system", "interviewer", "Okay so today we are going to focus on system design.", true, 250);
  ctx.ingestTranscript(finalA);
  transcriptEvents.push(finalA);

  const idB = "tx-b";
  ctx.ingestTranscript(evt(idB, "system", "interviewer", "How would you design", false, 300));
  ctx.ingestTranscript(evt(idB, "system", "interviewer", "How would you design Twitter", false, 350));
  const finalB = evt(idB, "system", "interviewer", "How would you design Twitter?", true, 400);
  ctx.ingestTranscript(finalB);
  transcriptEvents.push(finalB);

  assert(ctx.size() === 2, "context has 2 entries (one per utterance)");
  const recent = ctx.recent(10);
  const q = det.handle(finalB, recent);
  assert(q !== null, "question emitted");
  assert(q.question === "How would you design Twitter?", "question text preserved");
  assert(q.type === "system_design", "classified correctly");
  assert(q.recentContext.length >= 2, "context includes prior interviewer turn + maybe filler");
}

function test19_electron_app_boot() {
  // Sanity check: the main process source exists, references no missing exports,
  // and the build output includes the new conversation modules.
  console.log("\n[19] Electron main + new modules present in dist");
  const fs = require("fs");
  const required = [
    path.join(dist, "main", "index.js"),
    path.join(dist, "main", "conversation", "SpeakerAttributor.js"),
    path.join(dist, "main", "conversation", "InterviewContext.js"),
    path.join(dist, "main", "conversation", "QuestionDetector.js"),
    path.join(dist, "main", "conversation", "index.js"),
    path.join(dist, "main", "native", "captureExclusion.js"),
    path.join(dist, "preload", "overlay-preload.js"),
    path.join(dist, "common", "types.js"),
    path.join(dist, "main", "transcription", "TranscriptionManager.js"),
  ];
  for (const f of required) {
    assert(fs.existsSync(f), "exists: " + path.basename(f));
  }
  // Sanity: the main file references the new pipeline.
  const main = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
  assert(main.includes("SpeakerAttributor"), "main wires SpeakerAttributor");
  assert(main.includes("InterviewContext"), "main wires InterviewContext");
  assert(main.includes("QuestionDetector"), "main wires QuestionDetector");
  assert(main.includes("captureExclusion"), "main wires native captureExclusion");
}

async function main() {
  console.log("Intervia conversation + capture-exclusion suite");
  await test1_mic_is_candidate();
  await test2_system_is_interviewer();
  test4_final_replaces_partial();
  test3_partial_no_duplicate();
  test5_direct_question_mark();
  test6_imperative_question();
  test7_behavioral();
  test8_technical();
  test9_coding();
  test10_system_design();
  test11_followup();
  test12_statement_not_question();
  test13_duplicate_suppressed();
  test14_recent_context_attached();
  test15_context_bounded();
  await test16_existing_transcription_tests();
  test17_speaker_attributor_replaceable();
  test18_normalize_and_similarity();
  test20_pipeline_integration();
  test19_electron_app_boot();
  console.log("\n=================================");
  if (failed === 0) {
    console.log("ALL CONVERSATION TESTS PASSED");
    process.exit(0);
  } else {
    console.log("FAILED: " + failed);
    process.exit(1);
  }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });