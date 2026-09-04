/* eslint-disable */
// Focused tests for the window-lifecycle / Quit fix. Plain Node (no
// Electron): verifies the built main/preload/renderer wiring plus the pure
// tray-icon encoder. Existing hide/Escape/hotkey behavior must stay intact.

const path = require("path");
const fs = require("fs");
const dist = path.resolve(__dirname, "..", "dist");

const mainSrc = fs.readFileSync(path.join(dist, "main", "index.js"), "utf8");
const preloadSrc = fs.readFileSync(path.join(dist, "preload", "overlay-preload.js"), "utf8");
const overlayJs = fs.readFileSync(path.join(dist, "renderer", "overlay.js"), "utf8");
const overlayHtml = fs.readFileSync(path.join(dist, "renderer", "overlay.html"), "utf8");
const overlayCss = fs.readFileSync(path.join(dist, "renderer", "overlay.css"), "utf8");

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  PASS " + msg); }
  else { failed++; console.log("  FAIL " + msg); }
}

// [Q1] Quit IPC/action exists end to end.
function q1() {
  console.log("\n[Q1] Quit action exists");
  assert(mainSrc.includes("intervia:app:quit"), "main handles intervia:app:quit");
  assert(mainSrc.includes("requestQuit"), "main has requestQuit lifecycle entry");
  assert(preloadSrc.includes("quitApp"), "preload exposes quitApp");
  assert(overlayJs.includes("quitApp") && overlayJs.includes("quit-btn"), "overlay wires Quit button to quitApp");
  assert(overlayHtml.includes('id="quit-btn"') && overlayHtml.includes(">Quit<"), "overlay shows a visible Quit button");
  assert(overlayCss.includes(".btn.quit"), "Quit button has its own compact style");
}

// [Q2] Quit reaches the application lifecycle (terminates, not hides).
function q2() {
  console.log("\n[Q2] Quit terminates the app");
  const i = mainSrc.indexOf("requestQuit(reason)");
  assert(i >= 0, "requestQuit defined");
  const body = mainSrc.slice(i, i + 2500);
  assert(body.includes("app.quit()"), "requestQuit ends in app.quit()");
  assert(!body.includes("overlayWindow?.hide") && !body.includes(".hide()"), "quit path never merely hides the overlay");
}

// [Q3] Cleanup sequence executes in the quit path.
function q3() {
  console.log("\n[Q3] Cleanup sequence");
  const i = mainSrc.indexOf("requestQuit(reason)");
  const body = mainSrc.slice(i, i + 3000);
  const steps = [
    ["stopCapture", "mic/system capture stopped (AudioManager + transcription)"],
    ["stopAutoMonitoring", "screen monitoring stopped"],
    ["cancelPending", "pending screen/vision work cancelled"],
    ["answerEngine.cancel", "pending LLM work cancelled"],
    ["transcriptionManager.stop", "transcription connections stopped"],
    ["unregisterAll", "global shortcuts removed"],
    ["closeRegionSelector", "selector window closed"],
    ["closeSettingsWindow", "settings window closed"],
    ["closeDiagnosticsWindows", "diagnostics windows closed"],
  ];
  for (const [token, label] of steps) assert(body.includes(token), "quit cleanup: " + label);
  assert(/tray\?\.destroy|tray.destroy/.test(body), "quit cleanup: tray destroyed");
  assert(mainSrc.includes("closeDiagnosticsWindows()") && mainSrc.includes("diagnosticsWindows"), "diagnostics windows tracked for cleanup");
}

// [Q4] Repeated quit attempts are safe.
function q4() {
  console.log("\n[Q4] Repeated quit safety");
  const i = mainSrc.indexOf("requestQuit(reason)");
  const body = mainSrc.slice(i, i + 1200);
  assert(body.includes("this.quitting") && body.includes("already in progress"), "quitting guard makes repeat Quit safe");
}

// [Q5] Existing overlay hide behavior still works (hide != quit).
function q5() {
  console.log("\n[Q5] Hide behavior preserved");
  assert(mainSrc.includes("intervia:overlay:hide"), "hide IPC channel intact");
  assert(overlayJs.includes("hideOverlay"), "overlay still calls hideOverlay");
  assert(/key === "Escape"[\s\S]{0,120}hideOverlay/.test(overlayJs), "Escape still hides (not quits)");
  const hideIdx = mainSrc.indexOf("intervia:overlay:hide");
  const quitIdx = mainSrc.indexOf("intervia:app:quit");
  assert(hideIdx >= 0 && quitIdx >= 0 && hideIdx !== quitIdx, "hide and quit are separate channels");
}

// [Q6] Hotkeys: I/S intact, Q added without interference.
function q6() {
  console.log("\n[Q6] Hotkeys");
  assert(mainSrc.includes("CommandOrControl+Shift+I"), "Ctrl+Shift+I (show/hide) intact");
  assert(mainSrc.includes("CommandOrControl+Shift+S") || mainSrc.includes("screen.hotkey"), "Ctrl+Shift+S (region) intact");
  assert(mainSrc.includes("CommandOrControl+Shift+Q"), "Ctrl+Shift+Q (quit) added");
  const q = mainSrc.indexOf("CommandOrControl+Shift+Q");
  const seg = mainSrc.slice(Math.max(0, q - 200), q + 400);
  assert(seg.includes("requestQuit"), "quit hotkey converges on requestQuit");
}

// [Q7] Frameless overlay design preserved; taskbar behavior intentional.
function q7() {
  console.log("\n[Q7] Overlay design preserved");
  assert(mainSrc.includes("frame: false"), "frameless overlay preserved (no forced title bar)");
  assert(mainSrc.includes("skipTaskbar: true"), "skipTaskbar unchanged (overlay intent kept)");
  assert(mainSrc.includes("alwaysOnTop: true"), "always-on-top unchanged");
}

// [Q8] Tray secondary path (safe, optional).
function q8() {
  console.log("\n[Q8] Tray secondary path");
  assert(mainSrc.includes("setupTray") && mainSrc.includes("Tray("), "tray created at startup");
  assert(mainSrc.includes("Quit Intervia"), "tray menu has Quit Intervia");
  assert(/catch[\s\S]{0,200}Tray unavailable/.test(mainSrc) || mainSrc.includes("Tray unavailable"), "tray failure degrades gracefully (button + hotkey remain)");
  assert(mainSrc.includes("tray.setContextMenu") || mainSrc.includes("setContextMenu"), "tray has context menu");
}

// [Q9] Tray icon encoder is a valid PNG (headless-pure).
function q9() {
  console.log("\n[Q9] Tray icon encoder");
  const { encodePng, trayPixels, crc32 } = require(path.join(dist, "main", "trayIcon.js"));
  const png = encodePng(16, 16, trayPixels());
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert(png.slice(0, 8).equals(magic), "encoder emits PNG signature");
  assert(png.includes(Buffer.from("IDAT", "ascii")) && png.includes(Buffer.from("IEND", "ascii")), "encoder emits IDAT + IEND chunks");
  assert(typeof crc32(Buffer.from("123456789")) === "number", "crc32 runs");
  let threw = false;
  try { encodePng(16, 16, Buffer.alloc(10)); } catch (e) { threw = true; }
  assert(threw, "encoder rejects bad pixel buffers loudly");
}

// [Q10] Audio-device selection preserved + LOOPBACK_NOTE honest.
function q10() {
  console.log("\n[Q10] Audio-device selection preserved");
  assert(mainSrc.includes("LOOPBACK_NOTE"), "honest loopback note still wired");
  const devSrc = fs.readFileSync(path.join(dist, "main", "audio", "AudioDeviceManager.js"), "utf8");
  assert(devSrc.includes("does NOT retarget") || devSrc.includes("does not retarget"), "loopback limitation still stated (no fake retarget claim)");
  assert(preloadSrc.includes("audioDevicesGet") && preloadSrc.includes("audioDevicesSelectMic") && preloadSrc.includes("audioDevicesSelectOutput"),
    "device selection preload APIs intact");
  const cap = fs.readFileSync(path.join(dist, "renderer", "audio-capture.js"), "utf8");
  assert(cap.includes("micDevice") && cap.includes("DEVICE UNAVAILABLE"), "mic device constraint + unavailable path intact");
  const settings = fs.readFileSync(path.join(dist, "renderer", "settings.js"), "utf8");
  assert(settings.includes("mic-select") && settings.includes("output-select"), "Setup device dropdowns intact");
}

async function main() {
  console.log("Intervia quit-lifecycle suite");
  q1(); q2(); q3(); q4(); q5(); q6(); q7(); q8(); q9(); q10();
  console.log("\n=================================");
  console.log(`QUIT SUITE: ${passed} passed, ${failed} failed`);
  if (failed === 0) { console.log("ALL QUIT TESTS PASSED"); process.exit(0); }
  else { console.log("FAILED: " + failed); process.exit(1); }
}

main().catch((e) => { console.error("crashed", e); process.exit(2); });
