/* eslint-disable */
const api = window.intervia;

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function opt(sel, value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  sel.appendChild(o);
}

async function refreshProfiles() {
  const sel = el("profile-select");
  sel.innerHTML = "";
  try {
    const list = await api.profilesList();
    if (!list.length) opt(sel, "", "(no profiles)");
    for (const p of list) opt(sel, p.id, p.name + (p.headline ? " — " + p.headline : ""));
    if (list.length) {
      const first = await api.profilesGet(list[0].id).catch(() => null);
      el("profile-summary").textContent = first ? ((first.skills || []).slice(0, 8).join(", ") || "no skills yet") : "";
    }
  } catch (e) {
    el("profile-summary").textContent = "storage unavailable";
  }
}

async function refreshPersonas() {
  const sel = el("persona-select");
  sel.innerHTML = "";
  opt(sel, "", "(none)");
  try {
    const list = await api.personasList();
    for (const p of list) opt(sel, p.id, p.name);
    const mode = await api.modeGet().catch(() => "real");
    el("mode-select").value = mode;
  } catch (e) { /* ignore */ }
}

async function refreshJDs() {
  const sel = el("jd-select");
  sel.innerHTML = "";
  try {
    const list = await api.jdsList();
    if (!list.length) opt(sel, "", "(no JDs)");
    for (const j of list) opt(sel, j.id, j.title + (j.company ? " @ " + j.company : ""));
  } catch (e) { /* ignore */ }
}

async function refreshSessions() {
  const box = el("sessions-list");
  box.innerHTML = "";
  el("detail").textContent = "";
  try {
    const list = await api.sessionsList();
    if (!list.length) { box.innerHTML = '<span class="muted">No sessions yet.</span>'; return; }
    for (const s of list) {
      const div = document.createElement("div");
      div.className = "item";
      const when = new Date(s.startTime).toLocaleString();
      div.innerHTML = '<span class="grow">' + esc(when) + " · " + esc(s.status) + " · " + esc(s.questionCount) + "Q · " + esc(s.candidateMode) + "</span>";
      const open = document.createElement("button");
      open.className = "ghost";
      open.textContent = "Open";
      open.addEventListener("click", async () => {
        const full = await api.sessionsGet(s.id);
        renderSessionDetail(full);
      });
      const del = document.createElement("button");
      del.className = "ghost danger";
      del.textContent = "Clear";
      del.addEventListener("click", async () => {
        await api.sessionsClear(s.id);
        refreshSessions();
      });
      div.appendChild(open);
      div.appendChild(del);
      box.appendChild(div);
    }
  } catch (e) {
    box.innerHTML = '<span class="muted">history unavailable</span>';
  }
}

// Readable session review: what did they ask, what did Intervia say to say.
function renderSessionDetail(full) {
  const box = el("detail");
  if (!full) { box.textContent = "(missing)"; return; }
  const questions = Array.isArray(full.questions) ? full.questions : [];
  const answers = Array.isArray(full.answers) ? full.answers : [];
  const byQ = {};
  for (const a of answers) {
    if (!a || !a.questionId) continue;
    if (!byQ[a.questionId]) byQ[a.questionId] = [];
    byQ[a.questionId].push(a);
  }
  if (!questions.length) { box.textContent = "(no questions recorded)"; return; }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "muted";
  head.textContent = new Date(full.startTime).toLocaleString() + " · " + full.status + " · " + questions.length + " questions";
  box.appendChild(head);
  for (const q of questions) {
    const wrap = document.createElement("div");
    wrap.className = "diag";
    const when = q.timestamp ? new Date(q.timestamp).toLocaleTimeString() : "";
    const qLine = document.createElement("div");
    qLine.innerHTML = "<b>Q" + (when ? " (" + esc(when) + ")" : "") + " [" + esc(q.type || "general") + "]:</b> " + esc(q.text || "");
    wrap.appendChild(qLine);
    const list = (byQ[q.id] || []).filter((a) => !a.stale && a.status !== "unavailable");
    const strong = list.find((a) => a.role === "strong" && a.text) || list.find((a) => a.text);
    if (strong) {
      const aLine = document.createElement("div");
      aLine.innerHTML = "<b>A:</b> " + esc(String(strong.text).slice(0, 1200)) + (String(strong.text).length > 1200 ? "…" : "");
      wrap.appendChild(aLine);
      const meta = document.createElement("div");
      meta.className = "muted";
      const lat = strong.latencyMs ? " · " + strong.latencyMs + "ms" : "";
      meta.textContent = "via " + (strong.model || strong.provider || "?") + lat;
      wrap.appendChild(meta);
    } else {
      const none = document.createElement("div");
      none.className = "muted";
      none.textContent = "(no answer recorded)";
      wrap.appendChild(none);
    }
    box.appendChild(wrap);
  }
}

el("profile-use").addEventListener("click", async () => {
  await api.profilesSetActive(el("profile-select").value);
  refreshProfiles();
});
el("profile-new").addEventListener("click", async () => {
  const name = prompt("Profile name:", "My Resume");
  if (!name) return;
  const created = await api.profilesCreate(name);
  refreshProfiles();
  if (created && created.id) {
    el("profile-select").value = created.id;
    openProfileEditor(created.id);
  }
});
el("profile-edit").addEventListener("click", async () => {
  const id = el("profile-select").value;
  if (!id) return;
  openProfileEditor(id);
});
el("profile-import").addEventListener("click", async () => {
  el("profile-summary").textContent = "Importing...";
  const res = await api.profilesImport();
  el("profile-summary").textContent = res ? ("Imported via " + res.method + " (" + res.pages + "p)") : "Import cancelled";
  refreshProfiles();
  // Review workflow: open the imported profile for correction immediately.
  if (res && res.profile && res.profile.id) {
    el("profile-select").value = res.profile.id;
    openProfileEditor(res.profile.id);
  }
});

// --- PROFILE EDITOR (review + correct; provenance preserved) ---
let editingProfileId = null;
function csv(v) { return Array.isArray(v) ? v.join(", ") : ""; }
function lines(v) { return Array.isArray(v) ? v.join("\n") : ""; }
function parseCsv(s) { return String(s || "").split(",").map((x) => x.trim()).filter(Boolean); }
function parseLines(s) { return String(s || "").split("\n").map((x) => x.trim()).filter(Boolean); }
function parseJsonArr(s, what) {
  const t = String(s || "").trim();
  if (!t) return [];
  let v;
  try { v = JSON.parse(t); } catch (e) { throw new Error(what + " is not valid JSON: " + (e && e.message ? e.message : e)); }
  if (!Array.isArray(v)) throw new Error(what + " must be a JSON array");
  return v;
}

async function openProfileEditor(id) {
  const st = el("pe-status");
  st.textContent = "Loading...";
  try {
    const p = await api.profilesGet(id);
    if (!p) { st.textContent = "profile not found"; return; }
    editingProfileId = p.id;
    el("pe-name").value = p.name || "";
    el("pe-headline").value = p.headline || "";
    el("pe-summary").value = p.summary || "";
    el("pe-years").value = p.yearsExperience != null ? String(p.yearsExperience) : "";
    el("pe-skills").value = csv(p.skills);
    el("pe-tech").value = csv(p.technologies);
    el("pe-achieve").value = lines(p.achievements);
    el("pe-lang").value = csv(p.languages);
    el("pe-exp").value = JSON.stringify(p.experience || [], null, 1);
    el("pe-proj").value = JSON.stringify(p.projects || [], null, 1);
    el("pe-edu").value = JSON.stringify(p.education || [], null, 1);
    const facts = Array.isArray(p.verifiedFacts) ? p.verifiedFacts : [];
    el("pe-facts").textContent = facts.length
      ? facts.slice(0, 60).map((f) => "[" + (f.category || "?") + "/" + (f.source || "?") + "] " + (f.text || "")).join("\n")
      : "(no verified facts yet — add skills/experience above and save)";
    el("profile-editor").hidden = false;
    st.textContent = "";
  } catch (e) {
    st.textContent = "load failed: " + (e && e.message ? e.message : e);
  }
}

el("pe-cancel").addEventListener("click", () => {
  el("profile-editor").hidden = true;
  editingProfileId = null;
});
el("pe-save").addEventListener("click", async () => {
  const st = el("pe-status");
  if (!editingProfileId) return;
  st.textContent = "Saving...";
  try {
    const yearsRaw = el("pe-years").value.trim();
    const years = yearsRaw === "" ? null : Number(yearsRaw);
    if (yearsRaw !== "" && !Number.isFinite(years)) throw new Error("years of experience must be a number");
    // Editor patch path: main prunes stale user-entered facts, re-derives
    // them from these fields, and preserves resume-sourced facts untouched.
    const patch = {
      name: el("pe-name").value.trim(),
      headline: el("pe-headline").value.trim(),
      summary: el("pe-summary").value.trim(),
      yearsExperience: years,
      skills: parseCsv(el("pe-skills").value),
      technologies: parseCsv(el("pe-tech").value),
      achievements: parseLines(el("pe-achieve").value),
      languages: parseCsv(el("pe-lang").value),
      experience: parseJsonArr(el("pe-exp").value, "Experience"),
      projects: parseJsonArr(el("pe-proj").value, "Projects"),
      education: parseJsonArr(el("pe-edu").value, "Education"),
    };
    const res = await api.profilesSaveEditor(editingProfileId, patch);
    st.textContent = "saved (" + (res.addedFacts || 0) + " user-entered facts).";
    refreshProfiles();
    openProfileEditor(editingProfileId);
  } catch (e) {
    st.textContent = "save failed: " + (e && e.message ? e.message : e);
  }
});
el("profile-delete").addEventListener("click", async () => {
  if (!confirm("Delete this profile?")) return;
  await api.profilesDelete(el("profile-select").value);
  refreshProfiles();
});
el("save-skills").addEventListener("click", async () => {
  const id = el("profile-select").value;
  if (!id) return;
  const skills = el("edit-skills").value.split(",").map((s) => s.trim()).filter(Boolean);
  await api.profilesPatch(id, { skills });
  el("profile-summary").textContent = "skills saved (" + skills.length + ")";
});

el("mode-select").addEventListener("change", async () => {
  await api.modeSet(el("mode-select").value);
});
el("persona-use").addEventListener("click", async () => {
  await api.personasSetActive(el("persona-select").value || null);
});
el("persona-new").addEventListener("click", async () => {
  const name = prompt("Persona name:", "Mock Candidate A");
  if (!name) return;
  await api.personasCreate(name);
  refreshPersonas();
});

el("jd-use").addEventListener("click", async () => {
  await api.jdsSetActive(el("jd-select").value || null);
  refreshJDs();
});
el("jd-new").addEventListener("click", async () => {
  await api.jdsCreate("Untitled Role");
  refreshJDs();
});
el("jd-delete").addEventListener("click", async () => {
  if (!confirm("Delete this JD?")) return;
  await api.jdsDelete(el("jd-select").value);
  refreshJDs();
});
el("jd-save").addEventListener("click", async () => {
  const saved = await api.jdsSaveText(el("jd-title").value, el("jd-text").value);
  el("jd-summary").textContent = "saved: " + (saved.requiredSkills || []).length + " required skills";
  refreshJDs();
});
el("jd-edit").addEventListener("click", async () => {
  const id = el("jd-select").value;
  if (!id) return;
  openJdEditor(id);
});

// --- JD EDITOR (structured fields; parse flow above stays for new JDs) ---
let editingJdId = null;
function jdCsv(v) { return Array.isArray(v) ? v.join(", ") : ""; }
function jdLines(v) { return Array.isArray(v) ? v.join("\n") : ""; }

async function openJdEditor(id) {
  const st = el("je-status");
  st.textContent = "Loading...";
  try {
    const j = await api.jdsGet(id);
    if (!j) { st.textContent = "JD not found"; return; }
    editingJdId = j.id;
    el("je-title").value = j.title || "";
    el("je-company").value = j.company || "";
    el("je-summary").value = j.summary || "";
    el("je-resp").value = jdLines(j.responsibilities);
    el("je-req").value = jdCsv(j.requiredSkills);
    el("je-pref").value = jdCsv(j.preferredSkills);
    el("je-tech").value = jdCsv(j.technologies);
    el("je-qual").value = jdLines(j.experienceRequirements);
    el("jd-editor").hidden = false;
    st.textContent = "";
  } catch (e) {
    st.textContent = "load failed: " + (e && e.message ? e.message : e);
  }
}

el("je-cancel").addEventListener("click", () => {
  el("jd-editor").hidden = true;
  editingJdId = null;
});
el("je-save").addEventListener("click", async () => {
  const st = el("je-status");
  if (!editingJdId) return;
  st.textContent = "Saving...";
  try {
    const current = await api.jdsGet(editingJdId);
    if (!current) { st.textContent = "JD no longer exists"; return; }
    const updated = {
      ...current,
      title: el("je-title").value.trim() || "Untitled Role",
      company: el("je-company").value.trim(),
      summary: el("je-summary").value.trim(),
      responsibilities: String(el("je-resp").value || "").split("\n").map((x) => x.trim()).filter(Boolean),
      requiredSkills: String(el("je-req").value || "").split(",").map((x) => x.trim()).filter(Boolean),
      preferredSkills: String(el("je-pref").value || "").split(",").map((x) => x.trim()).filter(Boolean),
      technologies: String(el("je-tech").value || "").split(",").map((x) => x.trim()).filter(Boolean),
      experienceRequirements: String(el("je-qual").value || "").split("\n").map((x) => x.trim()).filter(Boolean),
    };
    await api.jdsSave(updated);
    st.textContent = "saved.";
    refreshJDs();
  } catch (e) {
    st.textContent = "save failed: " + (e && e.message ? e.message : e);
  }
});

el("sessions-refresh").addEventListener("click", refreshSessions);
el("sessions-clear").addEventListener("click", async () => {
  if (!confirm("Clear ALL session history?")) return;
  await api.sessionsClearAll();
  refreshSessions();
});

el("diag-run").addEventListener("click", async () => {
  const box = el("diag-list");
  box.innerHTML = '<span class="muted">checking...</span>';
  const list = await api.providersDiagnose(false);
  box.innerHTML = "";
  for (const d of list) {
    const div = document.createElement("div");
    div.className = "diag mono";
    div.textContent = d.provider + " | model=" + (d.model || "-") + " | configured=" + (d.configured ? "yes" : "no") + " | reachable=" + (d.reachable ? "yes" : "no") + " | streaming=" + d.streaming + (d.note ? " | " + d.note : "");
    box.appendChild(div);
  }
});
el("diag-open").addEventListener("click", async () => {
  await api.diagnosticsOpen();
});

// --- AUDIO DEVICES (compact selection; default behavior preserved) ---
// NOTE: this Setup window intentionally opens NO media stream of its own.
// Both level meters are driven by the existing capture pipeline: the hidden
// capture renderer reports scalar levels, main re-broadcasts them on the
// existing "intervia:audio:level" channel, and we render them here. When no
// capture/test is running the meters sit at an honest inactive -60 dB.
function shortId(id) {
  const s = String(id || "");
  if (!s || s === "default") return "(default)";
  return s.length <= 16 ? s : s.slice(0, 8) + "…" + s.slice(-4);
}

function fillDeviceSelect(sel, devices, selectedId, kindLabel) {
  sel.innerHTML = "";
  opt(sel, "default", "Default Device");
  devices.forEach((d, i) => {
    const label = (d.label || (d.kind === "output" ? "Output " : "Microphone ") + (i + 1)) + (d.isDefault ? " (default)" : "");
    opt(sel, d.id, label);
  });
  try {
    sel.value = selectedId || "default";
    if (sel.value !== (selectedId || "default")) sel.value = "default";
  } catch (e) { sel.value = "default"; }
}

// Mirrors src/main/audio/AudioLevel.ts levelToDb (canonical). Silence and any
// non-finite input map to -60 dB — never -Infinity, never NaN.
function levelToDb(level) {
  const n = Number(level);
  if (!Number.isFinite(n) || n <= 0) return -60;
  const c = Math.max(0.001, Math.min(1, n));
  const db = 20 * Math.log10(c);
  if (!Number.isFinite(db)) return -60;
  return Math.max(-60, Math.min(0, db));
}

// Latest enumerated outputs (for Play routing + availability checks).
let cachedOutputs = [];

function setDot(id, status) {
  const d = el(id);
  const ok = status === "AVAILABLE";
  const bad = status === "UNAVAILABLE";
  d.className = "dot " + (ok ? "ok" : bad ? "bad" : "unknown");
  d.title = ok ? "Available" : bad ? "Unavailable — use Defaults to recover" : "Unknown (not yet enumerated)";
}

async function refreshAudioDevices() {
  const note = el("devices-note");
  try {
    // Local enumeration (no extra permissions: labels may be empty until mic
    // permission was granted somewhere — main merges best-known labels).
    if (api.enumerateLocalDevices && api.audioDevicesReport) {
      const local = await api.enumerateLocalDevices().catch(() => []);
      if (local && local.length) api.audioDevicesReport(local);
    }
    const st = await api.audioDevicesGet();
    const inputs = (st && st.inputs) || [];
    const outputs = (st && st.outputs) || [];
    cachedOutputs = outputs.slice();
    fillDeviceSelect(el("mic-select"), inputs, st.selectedMicId, "mic");
    fillDeviceSelect(el("output-select"), outputs, st.selectedOutputId, "output");
    // Compact availability dots only — the verbose "AVAILABLE · label" text
    // was intentionally removed from this UI (labels live in the dropdowns).
    setDot("mic-status", st.micStatus);
    setDot("output-status", st.outputStatus);
    el("devices-note").textContent = (st.loopbackNote || "") +
      (inputs.length + outputs.length === 0 ? " No devices enumerated yet — run a mic/system test or refresh after granting mic access." : "");
  } catch (e) {
    note.textContent = "device list unavailable";
  }
}

el("mic-select").addEventListener("change", async () => {
  const res = await api.audioDevicesSelectMic(el("mic-select").value).catch(() => null);
  if (res && !res.ok) alert("Microphone selection failed: " + (res.error || "unknown"));
  refreshAudioDevices();
});
el("output-select").addEventListener("change", async () => {
  const res = await api.audioDevicesSelectOutput(el("output-select").value).catch(() => null);
  if (res && !res.ok) alert("Output selection failed: " + (res.error || "unknown"));
  el("output-play-status").textContent = "";
  refreshAudioDevices();
});
el("devices-refresh").addEventListener("click", async () => {
  await api.audioDevicesRefresh().catch(() => null);
  refreshAudioDevices();
});
el("devices-default").addEventListener("click", async () => {
  await api.audioDevicesReset("input").catch(() => null);
  await api.audioDevicesReset("output").catch(() => null);
  el("output-play-status").textContent = "";
  refreshAudioDevices();
});

// Re-enumerate when Windows devices come/go (no permission request — labels
// may stay empty until mic access was granted elsewhere; main merges).
try {
  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    let dcTimer = null;
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (dcTimer) return;
      dcTimer = setTimeout(() => { dcTimer = null; refreshAudioDevices(); }, 500);
    });
  }
} catch (e) { /* ignore */ }

// --- LIVE LEVEL METERS (driven by existing pipeline levels; rAF-rendered) ---
const meterState = {
  microphone: { target: 0, shown: 0, at: 0, hasSignal: false },
  system: { target: 0, shown: 0, at: 0, hasSignal: false },
};
const METER_WIDGETS = {
  microphone: { bar: "mic-meter", fill: "mic-meter-fill", db: "mic-db" },
  system: { bar: "sys-meter", fill: "sys-meter-fill", db: "sys-db" },
};
const STALE_MS = 1500;

function ingestLevel(evt) {
  if (!evt || typeof evt !== "object") return;
  const st = evt.source === "system" ? meterState.system
    : evt.source === "microphone" ? meterState.microphone : null;
  if (!st) return; // unknown source: ignore (never misassign a meter)
  const lv = Number(evt.level);
  st.target = Number.isFinite(lv) ? Math.max(0, Math.min(1, lv)) : 0;
  const ts = Number(evt.timestamp);
  st.at = ts > 0 ? ts : Date.now();
  st.hasSignal = true;
}

function renderMeter(source, now) {
  const st = meterState[source];
  const w = METER_WIDGETS[source];
  const bar = el(w.bar);
  const fill = el(w.fill);
  const dbEl = el(w.db);
  if (!bar || !fill || !dbEl) return;
  const stale = !st.hasSignal || (now - st.at) > STALE_MS;
  const tgt = stale ? 0 : st.target;
  // Fast attack (speech peaks show instantly), slow release (no flicker),
  // gentle decay to the floor when the pipeline is idle.
  const rate = tgt > st.shown ? 0.5 : stale ? 0.06 : 0.12;
  st.shown += (tgt - st.shown) * rate;
  if (Math.abs(tgt - st.shown) < 0.002) st.shown = tgt;
  fill.style.width = (st.shown * 100).toFixed(1) + "%";
  if (stale) bar.classList.add("inactive");
  else bar.classList.remove("inactive");
  // dB text throttled to ~10 Hz; never -Infinity/NaN (levelToDb floors).
  if (!renderMeter.lastText || now - renderMeter.lastText > 100) {
    renderMeter.lastText = now;
    for (const s of ["microphone", "system"]) {
      const ww = METER_WIDGETS[s];
      const dd = el(ww.db);
      if (dd) dd.textContent = Math.round(levelToDb(meterState[s].shown)) + " dB";
    }
  }
}

function meterFrame() {
  try {
    const now = Date.now();
    renderMeter("microphone", now);
    renderMeter("system", now);
  } catch (e) { /* never break the Setup window on a meter failure */ }
  requestAnimationFrame(meterFrame);
}

if (api.onAudioLevel) {
  try { api.onAudioLevel(ingestLevel); } catch (e) { /* fall back to polling */ }
}
// Fallback for hosts without the push channel: 1 s poll of the same scalars.
if (!api.onAudioLevel && api.diagnosticsAudioLevels) {
  setInterval(async () => {
    try {
      const lv = await api.diagnosticsAudioLevels();
      for (const k of ["microphone", "system"]) {
        if (lv && lv[k]) ingestLevel({ source: k, level: lv[k].level, timestamp: lv[k].at });
      }
    } catch (e) { /* keep last display on error */ }
  }, 1000);
}
requestAnimationFrame(meterFrame);

// --- OUTPUT TEST TONE (Setup Play button) ---
// Synthesizes a short 880 Hz / 500 ms ping at a safe moderate volume and
// routes it to the SELECTED output via setSinkId() when supported. This
// verifies the output device can receive audio; it is unrelated to loopback
// capture (which always records the system mix). No files, no network.
let playBusy = false;

function playToneToDevice(deviceId) {
  return new Promise((resolve, reject) => {
    void (async () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("Web Audio is not available in this window");
      const ctx = new AC();
      try {
        try {
          if (typeof ctx.resume === "function" && ctx.state === "suspended") await ctx.resume();
        } catch (e) { /* ignore resume failure; playback attempt still reports */ }
        const DUR = 0.5;
        const FREQ = 880;
        const PEAK = 0.2; // safe moderate volume
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = FREQ;
        const gain = ctx.createGain();
        const t0 = ctx.currentTime;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(PEAK, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + DUR);
        const dest = ctx.createMediaStreamDestination();
        osc.connect(gain);
        gain.connect(dest);
        const audio = new Audio();
        audio.srcObject = dest.stream;
        let routed = "default";
        if (deviceId && deviceId !== "default") {
          if (typeof audio.setSinkId === "function") {
            try {
              await audio.setSinkId(deviceId);
              routed = "selected";
            } catch (e) {
              const name = String((e && e.name) || "");
              if (/NotFound|Overconstrained/i.test(name)) {
                throw new Error("DEVICE UNAVAILABLE: selected output not found (" + (name || "unknown") + ")");
              }
              throw new Error("output routing failed: " + ((e && e.message) || name || String(e)));
            }
          } else {
            routed = "default-fallback";
          }
        }
        osc.start(t0);
        try { osc.stop(t0 + DUR + 0.05); } catch (e) { /* ignore */ }
        try {
          await audio.play();
        } catch (e) {
          throw new Error("playback rejected: " + ((e && e.message) || String(e)));
        }
        await new Promise((r) => setTimeout(r, Math.round(DUR * 1000) + 150));
        try { audio.pause(); } catch (e) { /* ignore */ }
        try { audio.srcObject = null; } catch (e) { /* ignore */ }
        resolve({ routed });
      } finally {
        try { await ctx.close(); } catch (e) { /* ignore */ }
      }
    })().catch(reject);
  });
}

el("output-play").addEventListener("click", async () => {
  if (playBusy) return; // debounced while the tone is playing
  const btn = el("output-play");
  const statusLine = el("output-play-status");
  const selId = el("output-select").value || "default";
  // Controlled unavailable path: a vanished non-default selection errors
  // without attempting playback and without crashing.
  if (selId !== "default" && cachedOutputs.length > 0 && !cachedOutputs.some((d) => d.id === selId)) {
    const msg = "DEVICE UNAVAILABLE — selected output is gone. Use Defaults to recover.";
    statusLine.textContent = msg;
    if (api.reportOutputTest) await api.reportOutputTest({ deviceId: selId, routed: "none", ok: false, error: msg }).catch(() => null);
    return;
  }
  playBusy = true;
  btn.disabled = true;
  btn.textContent = "\u266A Playing\u2026";
  statusLine.textContent = "";
  try {
    const res = await playToneToDevice(selId);
    statusLine.textContent = res.routed === "default-fallback"
      ? "Played via the default output (per-device routing is not supported in this host)."
      : res.routed === "selected"
        ? "Test tone played on the selected output."
        : "Test tone played on the default output.";
    if (api.reportOutputTest) {
      await api.reportOutputTest({ deviceId: selId, routed: res.routed, ok: true }).catch(() => null);
    }
  } catch (e) {
    const raw = String((e && e.message) || e || "playback failed");
    statusLine.textContent = /UNAVAILABLE|not found|NotFound|no such|gone/i.test(raw)
      ? raw + " Use Defaults to recover."
      : "Output test failed: " + raw;
    if (api.reportOutputTest) {
      await api.reportOutputTest({ deviceId: selId, routed: "none", ok: false, error: raw }).catch(() => null);
    }
  } finally {
    playBusy = false;
    btn.disabled = false;
    btn.textContent = "\u25B6 Play";
  }
});

// --- AI ANSWER CONFIGURATION (3-tier free fallback; keys local-only, never displayed) ---
function setKeyPlaceholder(inputId, present, label) {
  const inp = el(inputId);
  if (inp) inp.placeholder = label + (present ? " (saved ✓)" : " (not set)");
}

function tierDot(ready) {
  return ready ? "● Ready" : "○ Not configured";
}

async function refreshProviders() {
  const statusLine = el("providers-status");
  const summary = el("providers-summary");
  const aiSummary = el("ai-summary");
  const aiStatus = el("ai-status");
  try {
    const cfg = await api.providersGetConfig();
    const c = (cfg && cfg.config) || {};
    const kp = (cfg && cfg.keysPresent) || {};
    const ft = (cfg && cfg.freeTier) || {};
    // Normal 3-tier UI.
    if (el("ai-gemini-model")) el("ai-gemini-model").value = c.geminiModel || ft.geminiModel || "";
    if (el("adv-openrouter-model")) el("adv-openrouter-model").value = (c.openRouterModel && c.openRouterModel !== "openrouter/auto") ? c.openRouterModel : "";
    if (el("ai-gemini-status")) el("ai-gemini-status").textContent = tierDot(ft.geminiReady || !!kp.gemini);
    if (el("ai-openrouter-status")) el("ai-openrouter-status").textContent = tierDot(ft.openrouterReady || !!kp.openrouter);
    if (el("ai-local-status")) el("ai-local-status").textContent = (c.localEnabled === false) ? "○ Disabled" : "● Ready";
    if (aiSummary) {
      aiSummary.textContent = "Answers: " + (cfg.answerProviders || "Gemini Free → OpenRouter Free → Local AI") +
        " · Gemini " + ((ft.geminiReady || kp.gemini) ? "set" : "—") +
        " · OpenRouter " + ((ft.openrouterReady || kp.openrouter) ? "set" : "—") +
        " · Local " + ((c.localEnabled === false) ? "off" : "ready");
    }
    if (aiStatus) aiStatus.textContent = "";
    // STT / Vision stay separate from answer tiers.
    el("prov-stt").value = c.sttProvider || "whisper-server";
    el("prov-vision").value = c.visionMode || "local";
    // Screen reading: simple capability lines (no engine configuration).
    try {
      const sc = (cfg && cfg.screen) || {};
      const ocrLabel = sc.ocrLabel || "Local OCR";
      const ocrState = sc.ocrAvailable === false ? "○ Unavailable" : "● Ready";
      const visionLabel = sc.visionLabel || "Gemini Free";
      const visionState = (c.visionMode === "disabled") ? "○ Disabled" : (sc.visionAvailable === true ? "● Ready" : (sc.visionAvailable === false ? "○ Not configured" : "● Ready"));
      const scr = el("screen-summary");
      if (scr) scr.textContent = "OCR " + ocrState + " (" + ocrLabel + ") · Vision " + visionState + " (" + visionLabel + ")" +
        (sc.ocrAvailable === false ? " — install Tesseract for local screen reading" : "");
    } catch (e) { /* capability lines never break Setup */ }
    if (el("answerlen-select") && cfg) el("answerlen-select").value = cfg.answerLength || "medium";
    setKeyPlaceholder("ai-gemini-key", !!(ft.geminiReady || kp.gemini), "Gemini API key");
    setKeyPlaceholder("ai-openrouter-key", !!(ft.openrouterReady || kp.openrouter), "OpenRouter API key");
    // Advanced (legacy adapters stay internal; hidden from the normal flow).
    if (el("prov-fast")) el("prov-fast").value = c.fastProvider || "mock";
    if (el("prov-fast-model")) el("prov-fast-model").value = c.fastModel || "";
    if (el("prov-strong")) el("prov-strong").value = c.strongProvider || "mock";
    if (el("prov-strong-model")) el("prov-strong-model").value = c.strongModel || "";
    setKeyPlaceholder("key-gemini", !!kp.gemini, "Gemini API key");
    setKeyPlaceholder("key-minimax", !!kp.minimax, "MiniMax API key");
    setKeyPlaceholder("key-groq", !!kp.groq, "Groq API key");
    setKeyPlaceholder("key-openai", !!kp.openai, "OpenAI-compatible key");
    if (summary) {
      summary.textContent = "STT: " + (el("prov-stt").value || "?") + " · Vision: " + (el("prov-vision").value || "?") +
        " · Answers: " + (cfg.answerProviders || "?");
    }
    if (statusLine) statusLine.textContent = "";
  } catch (e) {
    if (summary) summary.textContent = "provider configuration unavailable";
    if (aiSummary) aiSummary.textContent = "AI configuration unavailable";
  }
}

if (el("ai-save")) {
  el("ai-save").addEventListener("click", async () => {
    const statusLine = el("ai-status");
    statusLine.textContent = "Saving...";
    try {
      const advModel = el("adv-openrouter-model") ? el("adv-openrouter-model").value : "";
      const payload = {
        geminiModel: el("ai-gemini-model") ? el("ai-gemini-model").value : undefined,
        openRouterModel: advModel !== undefined && String(advModel || "").trim() ? String(advModel).trim() : undefined,
        keys: {
          gemini: el("ai-gemini-key").value || (el("key-gemini") ? el("key-gemini").value : ""),
          openrouter: el("ai-openrouter-key").value,
        },
      };
      const res = await api.providersSetConfig(payload);
      if (res && res.ok) {
        el("ai-gemini-key").value = "";
        el("ai-openrouter-key").value = "";
        if (el("key-gemini")) el("key-gemini").value = "";
        statusLine.textContent = "saved. " + ((res.warnings || []).join(" ") || ("Answers: " + (res.answerProviders || "")));
        refreshProviders();
      } else {
        statusLine.textContent = "save failed: " + ((res && res.error) || "unknown");
      }
    } catch (e) {
      statusLine.textContent = "save failed: " + (e && e.message ? e.message : e);
    }
  });
}

el("providers-save").addEventListener("click", async () => {
  const statusLine = el("providers-status");
  statusLine.textContent = "Saving...";
  try {
    const payload = {
      sttProvider: el("prov-stt").value,
      visionMode: el("prov-vision").value,
      answerLength: el("answerlen-select") ? el("answerlen-select").value : undefined,
      keys: {
        minimax: el("key-minimax").value,
        groq: el("key-groq").value,
        openaiKey: el("key-openai").value,
      },
    };
    // Advanced legacy provider selections persist for internal reuse only.
    if (el("prov-fast") && el("prov-strong")) {
      payload.fastProvider = el("prov-fast").value;
      payload.fastModel = el("prov-fast-model").value;
      payload.strongProvider = el("prov-strong").value;
      payload.strongModel = el("prov-strong-model").value;
      const advGemini = el("key-gemini") ? el("key-gemini").value : "";
      if (advGemini) payload.keys.gemini = advGemini;
      const advOr = el("adv-openrouter-model") ? el("adv-openrouter-model").value : "";
      if (advOr && String(advOr).trim()) payload.openRouterModel = String(advOr).trim();
    }
    const res = await api.providersSetConfig(payload);
    if (res && res.ok) {
      el("key-minimax").value = "";
      el("key-groq").value = "";
      el("key-openai").value = "";
      if (el("key-gemini")) el("key-gemini").value = "";
      statusLine.textContent = "saved. " + ((res.warnings || []).join(" ") || ("Answers: " + (res.answerProviders || "")));
      refreshProviders();
    } else {
      statusLine.textContent = "save failed: " + ((res && res.error) || "unknown");
    }
  } catch (e) {
    statusLine.textContent = "save failed: " + (e && e.message ? e.message : e);
  }
});

if (el("answerlen-select")) {
  el("answerlen-select").addEventListener("change", async () => {
    try {
      await api.providersSetConfig({ answerLength: el("answerlen-select").value });
    } catch (e) { /* status line covers errors on full save */ }
  });
}

refreshAudioDevices();
refreshProfiles();
refreshPersonas();
refreshJDs();
refreshSessions();
refreshProviders();
