/* eslint-disable */
// Intervia hidden audio-capture renderer.
//
// Physical-machine lessons (do not regress):
//  1. AudioContext starts "suspended" in a hidden window (no user gesture).
//     A suspended context NEVER fires ScriptProcessor callbacks, so a
//     MediaStream can exist while zero frames flow. We resume() explicitly.
//  2. Chromium desktop (system-audio loopback) capture REQUIRES a video track
//     in the same getUserMedia call. Requesting { video: false } with
//     chromeMediaSource:"desktop" yields no usable audio. We request video and
//     discard it, keeping only the audio tracks.
//  3. Stream creation is NOT success. This renderer reports per-source stats
//     (track state, chunks, bytes, peak RMS) so main can distinguish
//     STREAM CREATED from FRAMES ACTUALLY RECEIVED. Raw audio is never logged.
const api = window.intervia;

const TARGET_SR = 16000;
const TARGET_CH = 1;
const CHUNK_MS = 250;

const statusEl = document.getElementById("status");
function setStatus(s) { if (statusEl) statusEl.textContent = s; }

const TARGET_FRAME = Math.round((TARGET_SR * CHUNK_MS) / 1000);

let sendCounter = 0;

// DSP lives in audio-dsp.js (loaded first by audio-capture.html; the same
// file is unit-tested in Node). Single canonical implementation — the live
// pipeline and the tests can never drift apart.
const Dsp = (typeof AudioDsp !== "undefined" && AudioDsp) || null;
function needDsp() {
  if (!Dsp) throw new Error("audio-dsp.js not loaded (capture graph requires it)");
  return Dsp;
}

// Per-source runtime stats. Reported to main; never contains raw audio.
const stats = {
  microphone: freshStats("microphone"),
  system: freshStats("system"),
};

function freshStats(source) {
  return {
    source,
    permission: "unknown",      // granted | denied:<name> | unknown
    deviceLabel: "",
    streamActive: false,
    trackReadyState: "none",    // live | ended | muted | none
    trackMuted: null,
    trackEnabled: null,
    trackEnded: false,
    sampleRate: 0,
    channelCount: 0,
    chunks: 0,
    bytes: 0,
    peakRms: 0,
    lastRms: 0,                 // RMS of the most recent frame (diagnostics)
    lastDb: -60,                // dBFS of the most recent frame (diagnostics)
    ctxState: "none",           // running | suspended | closed | none
    lastError: "",
    receiving: false,
    updatedAt: Date.now(),
  };
}

function touch(source) { stats[source].updatedAt = Date.now(); }

function snapshotStats() {
  // Plain-clone for IPC (device labels are sanitized: truncated, no ids).
  const out = {};
  for (const k of Object.keys(stats)) {
    const s = stats[k];
    s.receiving = s.chunks > 0;
    out[k] = { ...s, deviceLabel: String(s.deviceLabel || "").slice(0, 120) };
  }
  return out;
}

function pushStats() {
  try {
    if (api.sendStats) api.sendStats(snapshotStats());
  } catch (e) { /* ignore */ }
}

setInterval(pushStats, 500);

if (api.onQueryStats) {
  try { api.onQueryStats(() => pushStats()); } catch (e) { /* ignore */ }
}

// Device lost / unplugged / output changed: surface immediately.
try {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", async () => {
      for (const k of Object.keys(stats)) {
        stats[k].lastError = "device-change detected (device list changed)";
        touch(k);
      }
      try { api.sendError({ source: "microphone", message: "device-change (devices added/removed?)" }); } catch (e) { /* ignore */ }
      try {
        if (api.sendDeviceChange) api.sendDeviceChange(await enumerateAudioDevices());
      } catch (e) { /* ignore */ }
      pushStats();
    });
  }
} catch (e) { /* ignore */ }

function send(source, monoFloat, sourceSampleRate) {
  const dsp = needDsp();
  const resampled = dsp.resampleLinear(monoFloat, sourceSampleRate, TARGET_SR);
  const pcm = dsp.floatToInt16PCM(resampled);
  const buffer = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  api.sendChunk({ source, buffer, sampleRate: TARGET_SR, channels: TARGET_CH });
  api.sendSourceSampleRate(sourceSampleRate);
  const st = stats[source];
  st.chunks += 1;
  st.bytes += pcm.byteLength;
  // Frame statistics from the actual Float32 samples (canonical DSP).
  // lrms > 0 here PROVES the tap carries real signal: an all-zero tap can
  // only mean the graph feeds silence into the processor (see StreamPipeline).
  const frame = dsp.computeFrameStats(resampled);
  st.lastRms = Math.round(frame.rms * 10000) / 10000;
  st.lastDb = Math.round(frame.db * 10) / 10;
  if (frame.rms > st.peakRms) st.peakRms = Math.round(frame.rms * 10000) / 10000;
  touch(source);
  // Live input-level reporting for the Setup meters + diagnostics (~4 reports
  // per second per source: one per 250 ms frame). Payload stays {source, level}
  // — main clamps, converts to dB, tracks peak, and re-broadcasts on the same
  // channel. No raw audio leaves this pipeline; scalars only.
  sendCounter += 1;
  if (api.sendLevel) {
    try { api.sendLevel({ source, level: Math.max(0, Math.min(1, frame.rms * 3)) }); } catch (e) { /* ignore */ }
  }
}

class StreamPipeline {
  constructor(source, sourceNode, sampleRate) {
    this.source = source;
    this.sampleRate = sampleRate;
    this.buffer = [];
    this.bufferLen = 0;
    const ctx = sourceNode.context;
    this.ctx = ctx;
    const inCh = Math.max(1, Math.min(2, sourceNode.channelCount || 1));
    this.processor = ctx.createScriptProcessor(4096, inCh, 1);
    const self = this;
    this.processor.onaudioprocess = (e) => {
      try {
        const inBufs = [];
        for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
          inBufs.push(e.inputBuffer.getChannelData(c));
        }
        const mono = needDsp().downmixToMono(inBufs);
        self.buffer.push(mono);
        self.bufferLen += mono.length;
        while (self.bufferLen >= TARGET_FRAME) {
          const merged = new Float32Array(TARGET_FRAME);
          let filled = 0;
          let idx = 0;
          while (filled < TARGET_FRAME && idx < self.buffer.length) {
            const chunk = self.buffer[idx];
            const need = TARGET_FRAME - filled;
            const take = Math.min(chunk.length, need);
            merged.set(chunk.subarray(0, take), filled);
            filled += take;
            if (take < chunk.length) {
              self.buffer[idx] = chunk.subarray(take);
            } else {
              idx++;
            }
          }
          self.buffer.splice(0, idx);
          self.bufferLen -= filled;
          send(self.source, merged, self.sampleRate);
        }
      } catch (err) {
        api.sendError({ source: self.source, message: String(err) });
      }
    };
    // ROOT-CAUSE FIX (meters stuck at -60 dB with live tracks + frames):
    // the ScriptProcessor's inputBuffer is the OUTPUT of whatever feeds it.
    // A zero-gain node placed BEFORE the processor mutes the tap itself, so
    // onaudioprocess fires on schedule with all-zero samples while the track,
    // stream, chunks, bytes and AudioContext all look perfectly healthy.
    // Correct order taps the RAW source first and mutes only the speaker path:
    //   source -> processor -> muteGain(0) -> destination
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    sourceNode.connect(this.processor);
    this.processor.connect(this.mute);
    this.mute.connect(ctx.destination);
  }
  stop() {
    try { this.processor.disconnect(); } catch {}
    try { this.mute.disconnect(); } catch {}
  }
}

const pipelines = {};
const contexts = {};
const streams = {};

function trackInfo(track) {
  if (!track) return { readyState: "none", muted: null, enabled: null };
  return {
    readyState: track.muted ? "muted" : track.readyState,
    muted: !!track.muted,
    enabled: !!track.enabled,
  };
}

function watchTrack(stream, source) {
  try {
    stream.getAudioTracks().forEach((t) => {
      const st = stats[source];
      const ti = trackInfo(t);
      st.trackReadyState = ti.readyState;
      st.trackMuted = ti.muted;
      st.trackEnabled = ti.enabled;
      touch(source);
      t.addEventListener("ended", () => {
        stats[source].trackEnded = true;
        stats[source].trackReadyState = "ended";
        stats[source].streamActive = false;
        stats[source].lastError = "device-ended (mic unplugged or device lost?)";
        touch(source);
        api.sendError({ source, message: "device-ended (mic unplugged or device lost?)" });
        setStatus(source + ":device-ended");
        pushStats();
      });
      t.addEventListener("mute", () => {
        stats[source].trackMuted = true;
        stats[source].trackReadyState = "muted";
        touch(source);
        pushStats();
      });
      t.addEventListener("unmute", () => {
        stats[source].trackMuted = false;
        stats[source].trackReadyState = t.readyState;
        touch(source);
        pushStats();
      });
    });
  } catch (e) { /* ignore */ }
}

async function ensureRunningContext(ctx, source) {
  stats[source].ctxState = ctx.state;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (e) {
      stats[source].lastError = "AudioContext resume failed: " + String((e && e.message) || e);
    }
  }
  stats[source].ctxState = ctx.state;
  touch(source);
}

async function listAudioInputs() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return (devs || [])
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ label: String(d.label || "").slice(0, 120), idLen: String(d.deviceId || "").length }));
  } catch (e) {
    return [];
  }
}

// Full device enumeration for the AudioDeviceManager (main). Labels are
// empty until mic permission has been granted in this session — that is
// expected; main merges and degrades gracefully. No extra permission is
// requested just to list.
async function enumerateAudioDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return (devs || [])
      .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
      .map((d) => ({
        id: String(d.deviceId || ""),
        label: String(d.label || "").slice(0, 120),
        kind: d.kind === "audiooutput" ? "output" : "input",
        isDefault: String(d.deviceId || "").toLowerCase() === "default",
      }))
      .filter((d) => d.id.length > 0);
  } catch (e) {
    return [];
  }
}

async function reportDevices() {
  try {
    if (api.sendDevices) api.sendDevices(await enumerateAudioDevices());
  } catch (e) { /* ignore */ }
}

// Query params from main: ?mic=1&system=0/1&micDevice=<id>&sysOutput=<label>
let requestedMicDeviceId = null;
let selectedOutputLabel = "";
try {
  const qq = new URLSearchParams(window.location.search || "");
  const md = qq.get("micDevice");
  if (md) requestedMicDeviceId = md;
  const so = qq.get("sysOutput");
  if (so) selectedOutputLabel = so;
} catch (e) { /* ignore */ }

async function startMic() {
  const st = stats.microphone;
  try {
    // Use the user-selected microphone when configured; otherwise the
    // Windows/default device. A vanished device must surface as
    // DEVICE UNAVAILABLE — never crash, never silently use another mic.
    const audioConstraints = requestedMicDeviceId
      ? { channelCount: 1, echoCancellation: true, noiseSuppression: true, deviceId: { exact: requestedMicDeviceId } }
      : { channelCount: 1, echoCancellation: true, noiseSuppression: true };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    st.permission = "granted";
    streams.microphone = stream;
    st.streamActive = !!stream.active;
    const tracks = stream.getAudioTracks();
    const t = tracks[0];
    if (t && t.label) st.deviceLabel = String(t.label).slice(0, 120);
    if (!st.deviceLabel) {
      const inputs = await listAudioInputs();
      if (inputs.length > 0 && inputs[0].label) st.deviceLabel = inputs[0].label;
    }
    let srate = 48000;
    let ch = 1;
    try {
      const s = t && typeof t.getSettings === "function" ? t.getSettings() : {};
      if (s.sampleRate) srate = s.sampleRate;
      if (s.channelCount) ch = s.channelCount;
    } catch (e) { /* ignore */ }
    watchTrack(stream, "microphone");
    const ctx = new AudioContext();
    contexts.microphone = ctx;
    await ensureRunningContext(ctx, "microphone");
    srate = ctx.sampleRate || srate;
    const node = ctx.createMediaStreamSource(stream);
    try { ch = node.channelCount || ch; } catch (e) { /* ignore */ }
    st.sampleRate = srate;
    st.channelCount = ch;
    pipelines.microphone = new StreamPipeline("microphone", node, srate);
    touch("microphone");
    setStatus("mic:on " + srate + "Hz ctx=" + ctx.state);
    pushStats();
  } catch (e) {
    const name = (e && e.name ? e.name + ": " : "");
    const raw = String((e && e.name) || "") + String((e && e.message) || "");
    if (/NotAllowed|denied/i.test(raw)) {
      st.permission = "denied:" + String((e && e.name) || "unknown");
    }
    if (requestedMicDeviceId && /NotFound|Overconstrained|not find|unavailable/i.test(raw)) {
      st.lastError = "DEVICE UNAVAILABLE: selected microphone is unplugged/disabled — return to Default Device. (" + String((e && e.name) || "unknown") + ")";
    } else {
      st.lastError = String(name + ((e && e.message) ? e.message : e));
    }
    touch("microphone");
    api.sendError({ source: "microphone", message: String((e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : e)) });
    setStatus("mic:error");
    pushStats();
  }
}

async function startSystem() {
  const st = stats.system;
  try {
    const raw = await api.requestSystemSource();
    const sourceId = raw && typeof raw === "object" ? raw.id : raw;
    const sourceName = raw && typeof raw === "object" && raw.name ? String(raw.name).slice(0, 120) : "";
    if (sourceName) st.deviceLabel = sourceName;
    if (!sourceId) {
      st.lastError = "no system source available";
      touch("system");
      api.sendError({ source: "system", message: "no system source available" });
      pushStats();
      return;
    }
    // Chromium desktop loopback REQUIRES a video track in the same
    // getUserMedia call. Request it, then keep only the audio tracks.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 1280,
          maxHeight: 720,
        },
      },
    });
    st.permission = "granted";
    // Discard the video tracks: we only transcribe system audio.
    try {
      stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } });
    } catch (e) { /* ignore */ }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      st.lastError = "stream created but no audio track (loopback unavailable?)";
      st.streamActive = !!stream.active;
      touch("system");
      api.sendError({ source: "system", message: "stream created but contains no audio track" });
      setStatus("system:no-audio-track");
      pushStats();
      return;
    }
    streams.system = stream;
    st.streamActive = !!stream.active;
    watchTrack(stream, "system");
    const ctx = new AudioContext();
    contexts.system = ctx;
    await ensureRunningContext(ctx, "system");
    const node = ctx.createMediaStreamSource(stream);
    let ch = 1;
    try { ch = node.channelCount || ch; } catch (e) { /* ignore */ }
    st.sampleRate = ctx.sampleRate || 48000;
    st.channelCount = ch;
    pipelines.system = new StreamPipeline("system", node, st.sampleRate);
    touch("system");
    setStatus("system:on " + st.sampleRate + "Hz ctx=" + ctx.state);
    pushStats();
  } catch (e) {
    const name = (e && e.name ? e.name + ": " : "");
    st.lastError = String(name + ((e && e.message) ? e.message : e));
    if (/NotAllowed|denied/i.test(st.lastError)) st.permission = "denied:" + String((e && e.name) || "unknown");
    touch("system");
    api.sendError({ source: "system", message: String((e && e.name ? e.name + ": " : "") + (e && e.message ? e.message : e)) });
    setStatus("system:error");
    pushStats();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  // Main process passes ?mic=1&system=0/1 (previously both always started).
  let mic = true;
  let sys = true;
  try {
    const q = new URLSearchParams(window.location.search || "");
    if (q.has("mic")) mic = q.get("mic") === "1";
    if (q.has("system")) sys = q.get("system") === "1";
  } catch (e) { /* defaults stand */ }
  if (mic) startMic();
  if (sys) startSystem();
  if (!mic && !sys) setStatus("idle (no sources enabled)");
  // Report enumerated devices (labels included when permission granted).
  reportDevices();
  pushStats();
});

window.addEventListener("beforeunload", () => {
  for (const k in pipelines) { try { pipelines[k].stop(); } catch (e) { /* ignore */ } }
  for (const k in contexts) { try { contexts[k].close(); } catch (e) { /* ignore */ } }
  for (const k in streams) {
    try { streams[k].getTracks().forEach((t) => { try { t.stop(); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
  }
});
