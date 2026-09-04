/* eslint-disable */
// Targeted 3-tier FREE fallback suite: Gemini Free -> OpenRouter Free -> Local AI.
// Deterministic with stub providers (no keys, no network).
const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");
const { FreeFallbackRouter } = require(path.join(dist, "main", "reasoning", "FreeFallbackRouter.js"));
const { MockLLMProvider, FailingLLMProvider, LocalAIProvider } = require(path.join(dist, "main", "reasoning", "LLMProvider.js"));
const { ModelRouter } = require(path.join(dist, "main", "reasoning", "ModelRouter.js"));
const { AnswerEngine } = require(path.join(dist, "main", "reasoning", "AnswerEngine.js"));
const PC = require(path.join(dist, "main", "reasoning", "ProviderConfig.js"));

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}
function stub(name, text) {
  return { name, isAvailable: () => true, generate: async () => ({ text, model: name, latencyMs: 1 }), generateStream: async (req, onChunk) => { onChunk(text); return { text, model: name, latencyMs: 1 }; } };
}
function failingStub(name) {
  return { name, isAvailable: () => true, generate: async () => { throw new Error(name + " unavailable (429 rate limited)"); } };
}
function unavailableStub(name) {
  return { name, isAvailable: () => false, generate: async () => { throw new Error("should be skipped"); } };
}

async function main() {
  console.log("Intervia 3-tier fallback suite");
  // [1] Primary success: later tiers never called.
  {
    let calls = 0;
    const second = { name: "openrouter-free-llm", isAvailable: () => true, generate: async () => { calls++; return { text: "SECOND", model: "m", latencyMs: 1 }; } };
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: stub("gemini-free-llm", "PRIMARY") }, { tier: "openrouter-free", provider: second }, { tier: "local", provider: new LocalAIProvider() }] });
    const out = await r.generate({ prompt: "CURRENT QUESTION\nHi?\n\n", maxTokens: 20 });
    assert(out.text === "PRIMARY" && calls === 0, "primary success skips fallback tiers");
    assert(String(out.model).startsWith("gemini-free:"), "result carries tier prefix");
  }
  // [2] Primary rate-limit -> OpenRouter.
  {
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: failingStub("gemini-free-llm") }, { tier: "openrouter-free", provider: stub("openrouter-free-llm", "BACKUP") }, { tier: "local", provider: new LocalAIProvider() }] });
    const out = await r.generate({ prompt: "CURRENT QUESTION\nHi?\n\n", maxTokens: 20 });
    assert(out.text === "BACKUP" && String(out.model).startsWith("openrouter-free:"), "rate-limited primary falls back to OpenRouter Free");
  }
  // [3] Both clouds fail -> Local AI.
  {
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: failingStub("g") }, { tier: "openrouter-free", provider: failingStub("o") }, { tier: "local", provider: new LocalAIProvider() }] });
    const out = await r.generate({ prompt: "CURRENT QUESTION\nWhat is SQL?\n\n", maxTokens: 60 });
    assert(out.text.length > 0 && String(out.model).startsWith("local:"), "cloud failures reach Local AI final fallback");
  }
  // [4] Unconfigured tiers skipped without waiting.
  {
    const t0 = Date.now();
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: unavailableStub("g") }, { tier: "openrouter-free", provider: unavailableStub("o") }, { tier: "local", provider: new LocalAIProvider() }] });
    const out = await r.generate({ prompt: "CURRENT QUESTION\nHi?\n\n", maxTokens: 20 });
    assert(out.text.length > 0 && Date.now() - t0 < 5000, "unconfigured tiers skip fast to Local");
  }
  // [5] Abort never falls back.
  {
    const second = stub("openrouter-free-llm", "BACKUP");
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: stub("gemini-free-llm", "P") }, { tier: "openrouter-free", provider: second }] });
    const ctrl = new AbortController();
    ctrl.abort();
    let threw = false;
    try { await r.generate({ prompt: "x", signal: ctrl.signal }); } catch { threw = true; }
    assert(threw, "aborted request rethrows without fallback");
  }
  // [6] Streaming fallback before any chunk.
  {
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: failingStub("g") }, { tier: "openrouter-free", provider: stub("openrouter-free-llm", "STREAM-BACKUP") }] });
    const deltas = [];
    const out = await r.generateStream({ prompt: "CURRENT QUESTION\nHi?\n\n", maxTokens: 20 }, (d) => deltas.push(d));
    assert(out.text === "STREAM-BACKUP" && deltas.join("") === "STREAM-BACKUP", "stream failure with no text falls back cleanly");
  }
  // [7] No permanent downgrade: next question retries primary.
  {
    let n = 0;
    const flaky = { name: "gemini-free-llm", isAvailable: () => true, generate: async () => { n++; if (n === 1) throw new Error("gemini timeout"); return { text: "RECOVERED", model: "m", latencyMs: 1 }; } };
    const r = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: flaky }, { tier: "openrouter-free", provider: stub("openrouter-free-llm", "BACKUP") }] });
    const first = await r.generate({ prompt: "q1", maxTokens: 10 });
    const second = await r.generate({ prompt: "q2", maxTokens: 10 });
    assert(first.text === "BACKUP" && second.text === "RECOVERED", "transient failure does not poison the next question");
  }
  // [8] Fast+Strong preserved over fallback routers.
  {
    const fast = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: stub("gemini-free-llm", "fast-draft") }, { tier: "local", provider: new LocalAIProvider() }], label: "free-fallback-fast" });
    const strong = new FreeFallbackRouter({ tiers: [{ tier: "gemini-free", provider: failingStub("g") }, { tier: "local", provider: new LocalAIProvider() }], label: "free-fallback-strong" });
    const eng = new AnswerEngine(new ModelRouter(fast, strong));
    const res = await eng.answer({ questionId: "q", question: "What is React?", recentContext: [] });
    assert(res.fast.length > 0 && res.strong.length > 0, "fast preliminary + strong refined both complete over fallback");
    assert(String(res.strongModel).startsWith("local:"), "strong fallback tier recorded honestly");
  }
  // [9] Config migration + free defaults + key hygiene.
  {
    const cfg = PC.sanitizeProviderConfig({ fastProvider: "gemini", fastModel: "gemini-2.5-flash", strongProvider: "mock", sttProvider: "whisper-server", visionMode: "local" });
    assert(!!cfg.geminiModel && !!cfg.openRouterModel && cfg.localEnabled === true, "3-tier fields default + migrate safely");
    const k = PC.sanitizeProviderKeys({ gemini: "K1", openrouter: "K2", minimax: "" });
    assert(k.gemini === "K1" && k.openrouter === "K2" && !("minimax" in k), "openrouter key sanitized, blanks dropped");
    const presence = PC.keysPresent({ gemini: "K1", openrouter: "K2" });
    assert(presence.gemini === true && presence.openrouter === true, "presence-only readiness (no values)");
    assert(JSON.stringify(presence).indexOf("K1") === -1, "no key value leaks");
  }
  console.log("\n=================================");
  console.log(`FALLBACK SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL FALLBACK TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}
main().catch((e) => { console.error("crashed", e); process.exit(2); });
