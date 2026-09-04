/* eslint-disable */
const api = window.intervia;

const toggleBtn = document.getElementById("toggle-btn");
const clearBtn = document.getElementById("clear-btn");
const statusPill = document.getElementById("status-pill");
const providerInfo = document.getElementById("provider-info");
const micText = document.getElementById("mic-text");
const systemText = document.getElementById("system-text");
const contextList = document.getElementById("context-list");
const questionCard = document.getElementById("question-card");
const questionText = document.getElementById("question-text");
const questionType = document.getElementById("question-type");
const questionConf = document.getElementById("question-conf");
const questionEmpty = document.getElementById("question-empty");
const answerEmpty = document.getElementById("answer-empty");
const answerFast = document.getElementById("answer-fast");
const answerStrong = document.getElementById("answer-strong");
const answerState = document.getElementById("answer-state");

function setAnswerState(label) {
  if (!answerState) return;
  if (!label) { answerState.hidden = true; return; }
  answerState.hidden = false;
  answerState.textContent = label;
}
const screenState = document.getElementById("screen-state");
const ocrState = document.getElementById("ocr-state");
const visionState = document.getElementById("vision-state");
const screenText = document.getElementById("screen-text");
const screenBtn = document.getElementById("screen-btn");
const captureBtn = document.getElementById("capture-btn");
const selectBtn = document.getElementById("select-btn");
const setupBtn = document.getElementById("setup-btn");
const profileLabel = document.getElementById("profile-label");
const personaLabel = document.getElementById("persona-label");
const jobLabel = document.getElementById("job-label");
const sessionLabel = document.getElementById("session-label");

let capturing = false;

const finalsBySource = { microphone: [], system: [] };
const partialBySource = { microphone: "", system: "" };

const ctxEntries = []; // ordered context entries
const MAX_CTX_VISIBLE = 12;

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderStreams() {
  for (const src of ["microphone", "system"]) {
    const el = src === "microphone" ? micText : systemText;
    const lines = finalsBySource[src].slice(-3).map((t) => `<div class="final">${escapeHtml(t)}</div>`).join("");
    const partial = partialBySource[src] ? `<div class="partial">${escapeHtml(partialBySource[src])}</div>` : "";
    el.innerHTML = lines + partial || (src === "microphone" ? "Listening..." : "Waiting for interview audio...");
  }
}

// Transcript partials arrive hot: coalesce DOM writes (~4/s max) instead of
// rebuilding innerHTML per event.
let streamsTimer = null;
function renderStreamsSoon() {
  if (streamsTimer) return;
  streamsTimer = setTimeout(() => {
    streamsTimer = null;
    try {
      renderStreams();
    } catch (e) { /* never break the overlay on a paint failure */ }
  }, 250);
}

function renderContext() {
  if (ctxEntries.length === 0) {
    contextList.innerHTML = '<div class="muted">No context yet.</div>';
    return;
  }
  const visible = ctxEntries.slice(-MAX_CTX_VISIBLE);
  contextList.innerHTML = visible.map((e) => {
    const speaker = (e.speaker || "unknown");
    const speakerLabel = speaker.charAt(0).toUpperCase() + speaker.slice(1);
    return `<div class="ctx-entry"><div class="ctx-speaker ${escapeHtml(speaker)}">${escapeHtml(speakerLabel)}</div><div class="ctx-text">${escapeHtml(e.text)}</div></div>`;
  }).join("");
  contextList.scrollTop = contextList.scrollHeight;
}

function renderQuestion(q) {
  questionCard.hidden = false;
  questionEmpty.hidden = true;
  questionText.textContent = q.question;
  questionType.textContent = q.type;
  questionConf.textContent = "conf " + (q.confidence * 100).toFixed(0) + "%";
  // New question supersedes old answers.
  answerFast.hidden = true;
  answerStrong.hidden = true;
  answerEmpty.hidden = false;
  answerEmpty.textContent = "Thinking...";
  setAnswerState("THINKING");
}

function renderAnswer(a) {
  if (!a || a.stale) return;
  if (a.kind === "fast") {
    answerEmpty.hidden = true;
    answerFast.hidden = false;
    answerFast.textContent = a.text;
    // Partials render progressively; state advances only on the final.
    setAnswerState(a.partial ? "PRELIMINARY…" : "PRELIMINARY · REFINING…");
  } else if (a.kind === "strong") {
    answerEmpty.hidden = true;
    answerStrong.hidden = false;
    answerStrong.textContent = a.text;
    if (!a.partial) setAnswerState("REFINED");
  }
}

function renderScreenStatus(s) {
  if (!screenState) return;
  const scr = (s && s.screen) || {};
  const on = !!scr.monitoring;
  screenState.textContent = on ? "ON" : "OFF";
  screenState.className = "pill " + (on ? "listening" : "ready");
  if (screenBtn) screenBtn.textContent = on ? "Screen: Stop" : "Screen: Start";
  if (ocrState) ocrState.textContent = "OCR " + String(scr.ocr || "-").toUpperCase();
  if (visionState) visionState.textContent = "VISION " + String(scr.vision || "-").toUpperCase();
  if (screenText && scr.lastText) screenText.textContent = scr.lastText.slice(0, 160);
}

function renderScreenEvent(e) {
  if (!screenText || !e) return;
  const t = e.detectedQuestion || e.text || "";
  screenText.textContent = String(t).slice(0, 160) || "Screen updated (no text).";
  screenText.className = "text";
}

function renderAnswerError(e) {
  if (!e) return;
  answerEmpty.hidden = true;
  answerFast.hidden = false;
  answerFast.textContent = "Answer generation unavailable — question and session saved.";
  setAnswerState("UNAVAILABLE");
}

function renderCandidateStatus(s) {
  if (profileLabel) profileLabel.innerHTML = "Profile: <b>" + escapeHtml(s.profileName || "none") + "</b>";
  if (personaLabel) personaLabel.innerHTML = "Persona: <b>" + escapeHtml(s.personaLabel || "Real") + "</b>";
  if (jobLabel) jobLabel.innerHTML = "Job: <b>" + escapeHtml(s.jobTitle || "none") + "</b>";
  if (sessionLabel) {
    const st = s.sessionStatus || "none";
    const n = s.sessionQuestionCount || 0;
    sessionLabel.innerHTML = "Session: <b>" + escapeHtml(st) + (st === "running" ? " (" + n + "Q)" : "") + "</b>";
  }
}

function setStatus(label, cls) {
  statusPill.textContent = label;
  statusPill.className = "pill " + cls;
}

toggleBtn.addEventListener("click", async () => {
  capturing = await api.toggleCapture();
  updateBtn();
});

clearBtn.addEventListener("click", async () => {
  await api.clearContext();
  ctxEntries.length = 0;
  renderContext();
  questionCard.hidden = true;
  questionEmpty.hidden = false;
});

if (screenBtn) {
  screenBtn.addEventListener("click", async () => {
    try {
      const on = screenState && screenState.textContent === "ON";
      if (on) await api.screenStop();
      else await api.screenStart();
    } catch (e) { /* overlay stays usable if screen fails */ }
  });
}
if (captureBtn) {
  captureBtn.addEventListener("click", async () => {
    try { await api.screenCaptureNow(); } catch (e) { /* ignore */ }
  });
}
if (selectBtn) {
  selectBtn.addEventListener("click", async () => {
    try { await api.screenSelectRegion(); } catch (e) { /* ignore */ }
  });
}
if (setupBtn) {
  setupBtn.addEventListener("click", async () => {
    try { await api.openSettings(); } catch (e) { /* ignore */ }
  });
}
const quitBtn = document.getElementById("quit-btn");
if (quitBtn) {
  // Real Quit: terminates Intervia completely (NOT a hide — Escape/Ctrl+Shift+I
  // only hide the overlay; this button always ends the process).
  quitBtn.addEventListener("click", async () => {
    try { await api.quitApp(); } catch (e) { /* main owns the lifecycle */ }
  });
}

function updateBtn() {
  toggleBtn.textContent = capturing ? "Stop" : "Start";
  toggleBtn.classList.toggle("stop", capturing);
}

function renderProviderLine(s) {
  const stt = s.providerName || "-";
  const ans = s.answerProviderName || "";
  providerInfo.textContent = "STT: " + stt + (ans ? " · Answers: " + ans : "") +
    (s.errorMessage ? " — " + s.errorMessage : "");
}

api.onStatus((s) => {
  renderProviderLine(s);
  switch (s.transcription) {
    case "idle": setStatus("Idle", "ready"); break;
    case "ready": setStatus("Ready", "ready"); break;
    case "listening": setStatus("Listening", "listening"); break;
    case "processing": setStatus("Processing", "processing"); break;
    case "error": setStatus("Error", "error"); break;
  }
  renderScreenStatus(s);
  renderCandidateStatus(s || {});
});

if (api.onAnswerError) {
  api.onAnswerError((e) => {
    renderAnswerError(e);
  });
}

if (api.onAnswer) {
  api.onAnswer((a) => {
    renderAnswer(a);
  });
}

if (api.onScreen) {
  api.onScreen((e) => {
    renderScreenEvent(e);
  });
}

api.onTranscript((t) => {
  if (!t || !t.text) return;
  if (t.isFinal) {
    finalsBySource[t.source].push(t.text);
    partialBySource[t.source] = "";
    try {
      renderStreams();
    } catch (e) { /* ignore */ }
  } else {
    partialBySource[t.source] = t.text;
    renderStreamsSoon();
  }
});

api.onContext((entry) => {
  if (entry.id === "snapshot") return;
  const idx = ctxEntries.findIndex((e) => e.transcriptEventId === entry.transcriptEventId);
  if (idx >= 0) {
    ctxEntries[idx] = entry;
  } else {
    ctxEntries.push(entry);
  }
  if (ctxEntries.length > 200) ctxEntries.splice(0, ctxEntries.length - 200);
  renderContext();
});

api.onQuestion((q) => {
  renderQuestion(q);
});

api.getStatus().then((s) => {
  if (!s) return;
  renderProviderLine(s);
  if (s.transcription) {
    setStatus(s.transcription[0].toUpperCase() + s.transcription.slice(1), s.transcription === "listening" ? "listening" : s.transcription === "processing" ? "processing" : s.transcription === "error" ? "error" : "ready");
  }
  renderScreenStatus(s);
  renderCandidateStatus(s || {});
});

api.getContextSnapshot().then((snap) => {
  if (Array.isArray(snap)) {
    ctxEntries.length = 0;
    for (const e of snap) ctxEntries.push(e);
    renderContext();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    api.hideOverlay();
  }
});

renderContext();
renderStreams();