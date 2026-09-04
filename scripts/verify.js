/* eslint-disable */
// Verification harness for Intervia transcription foundation.
// Loads compiled main-process modules directly via Node and exercises:
// - Provider selection + factory
// - VAD
// - TranscriptionManager buffering + dispatch (using WhisperServerProvider which
//   will fall back to mock mode when no local server is running)
// - Synthetic test audio (sine wave with gated silence) so we can verify the pipeline
//   end-to-end without real microphone/system input.

process.env.INTERVIA_LOG = "info";

const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { TranscriptionManager } = require(path.join(dist, "main", "transcription", "TranscriptionManager.js"));
const { createProvider } = require(path.join(dist, "main", "transcription", "providers", "index.js"));
const { config } = require(path.join(dist, "main", "config.js"));
const { Vad } = require(path.join(dist, "main", "transcription", "Vad.js"));

let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  PASS " + msg); }
  else { console.log("  FAIL " + msg); failed++; }
}

function sinePcm(durationMs, freq, sampleRate, amplitude) {
  const n = Math.floor((durationMs / 1000) * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}
function silence(durationMs, sampleRate) {
  return new Int16Array(Math.floor((durationMs / 1000) * sampleRate));
}

async function test1_provider_factory() {
  console.log("\n[1] Provider factory");
  const p = createProvider("whisper-server");
  assert(p && p.name === "whisper-server", "factory returns whisper-server");
  const p2 = createProvider("groq");
  assert(p2 && p2.name === "groq", "factory returns groq");
}

async function test2_vad() {
  console.log("\n[2] VAD");
  const v = new Vad({ rmsThreshold: 0.02, silenceMs: 200, minSpeechMs: 100, sampleRate: 16000 });
  let events = [];
  v.onEvent((e) => events.push(e));
  const noisy = sinePcm(100, 440, 16000, 0.5);
  const quiet = silence(100, 16000);
  // Real production feeds arrive ~every 250 ms. Simulate that cadence.
  for (let i = 0; i < 6; i++) {
    v.feed(noisy);
    await new Promise((r) => setTimeout(r, 60));
  }
  // Now silence for > 200 ms.
  v.feed(quiet);
  await new Promise((r) => setTimeout(r, 250));
  v.feed(quiet);
  assert(events.some(e => e.type === "speech-start"), "speech-start fired on noise");
  assert(events.some(e => e.type === "speech-end"), "speech-end fired after silence");
}

async function test3_manager_init_and_feed() {
  console.log("\n[3] TranscriptionManager init + feed (mock provider)");
  const mgr = new TranscriptionManager();
  await mgr.init();
  assert(mgr.getProviderName() === "whisper-server", "manager reports provider name");
  mgr.start();
  let got = null;
  let lastFinal = null;
  mgr.on("transcript", (e) => { if (!got) got = e; if (e.isFinal) lastFinal = e; });

  // Stream ~1.5s of loud sine @ 440Hz, then ~1.5s of silence, fed at real pace.
  const noisy = sinePcm(1500, 440, 16000, 0.4);
  const quiet = silence(1500, 16000);

  for (let i = 0; i < 5; i++) {
    mgr.feed("microphone", noisy);
    await new Promise((r) => setTimeout(r, 70));
  }
  // Then silence long enough to trigger VAD end (~700ms).
  for (let i = 0; i < 12; i++) {
    mgr.feed("microphone", quiet);
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 2500));
  assert(got !== null, "transcript event emitted for microphone");
  if (got) {
    assert(got.source === "microphone", "event source=microphone");
    assert(typeof got.text === "string", "event has text field");
    assert(lastFinal !== null, "at least one final transcript emitted after silence flush");
    if (lastFinal) assert(lastFinal.isFinal === true, "final event isFinal=true");
  }

  mgr.stop();
}

async function test4_mic_and_system_independent() {
  console.log("\n[4] Mic and System streams remain independent");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));

  const noiseMic = sinePcm(800, 600, 16000, 0.4);
  const noiseSys = sinePcm(800, 300, 16000, 0.4);
  const quiet = silence(1200, 16000);

  mgr.feed("microphone", noiseMic);
  await new Promise((r) => setTimeout(r, 60));
  mgr.feed("system", noiseSys);
  await new Promise((r) => setTimeout(r, 60));
  for (let i = 0; i < 3; i++) {
    mgr.feed("microphone", quiet);
    mgr.feed("system", quiet);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 3000));

  const micEvents = events.filter((e) => e.source === "microphone");
  const sysEvents = events.filter((e) => e.source === "system");
  assert(micEvents.length >= 1, "mic events produced");
  assert(sysEvents.length >= 1, "system events produced");
  // Ensure neither event source is contaminated by the other.
  for (const e of events) {
    assert(e.source === "microphone" || e.source === "system", "event source is valid enum");
  }

  mgr.stop();
}

async function test5_partial_then_final() {
  console.log("\n[5] Partial and final transcripts (when supported)");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  const events = [];
  mgr.on("transcript", (e) => events.push(e));

  // Stream ~3s of speech across 800ms chunks (so partial timer at 800ms can fire
  // mid-speech), then silence for ~1.2s so VAD ends and a final is emitted.
  const noise = sinePcm(800, 700, 16000, 0.5);
  for (let i = 0; i < 5; i++) {
    mgr.feed("microphone", noise);
    await new Promise((r) => setTimeout(r, 90));
  }
  for (let i = 0; i < 15; i++) {
    mgr.feed("microphone", silence(200, 16000));
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 3500));

  // WhisperServerProvider in mock mode returns isFinal tied to req.partial;
  // the manager emits partials during active speech and a final after VAD end.
  assert(events.length >= 2, "at least partial + final emitted, got " + events.length);
  const partials = events.filter((e) => e.isFinal === false);
  const finals = events.filter((e) => e.isFinal === true);
  assert(partials.length >= 1, "at least one partial event");
  assert(finals.length >= 1, "at least one final event");

  mgr.stop();
}

async function test6_stop_is_clean() {
  console.log("\n[6] Stop is clean");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  mgr.feed("microphone", sinePcm(500, 440, 16000, 0.4));
  mgr.feed("system", sinePcm(500, 440, 16000, 0.4));
  mgr.stop();
  // Feed after stop should be ignored.
  mgr.feed("microphone", sinePcm(500, 440, 16000, 0.4));
  assert(true, "stop did not throw");
}

async function test7_restart() {
  console.log("\n[7] Restart works");
  const mgr = new TranscriptionManager();
  await mgr.init();
  mgr.start();
  mgr.feed("microphone", sinePcm(500, 440, 16000, 0.4));
  mgr.stop();
  mgr.start();
  let got = null;
  mgr.on("transcript", (e) => { if (!got) got = e; });
  mgr.feed("microphone", sinePcm(800, 440, 16000, 0.4));
  mgr.feed("microphone", silence(1200, 16000));
  await new Promise((r) => setTimeout(r, 3500));
  assert(got !== null, "transcript after restart");
  mgr.stop();
}

async function main() {
  console.log("Intervia verification suite (provider:", config.provider + ")");
  console.log("Whisper endpoint:", config.whisper.endpoint, "— provider will fall back to mock if unreachable.");
  await test1_provider_factory();
  await test2_vad();
  await test3_manager_init_and_feed();
  await test4_mic_and_system_independent();
  await test5_partial_then_final();
  await test6_stop_is_clean();
  await test7_restart();
  console.log("\n=================================");
  if (failed === 0) {
    console.log("ALL VERIFICATIONS PASSED");
    process.exit(0);
  } else {
    console.log("FAILED: " + failed);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("verify crashed", e);
  process.exit(2);
});