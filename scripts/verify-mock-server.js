/* eslint-disable */
// Spin up a minimal mock whisper.cpp server and exercise WhisperServerProvider against it.
const http = require("http");
const path = require("path");
const dist = path.resolve(__dirname, "..", "dist");

const { WhisperServerProvider } = require(path.join(dist, "main", "transcription", "providers", "WhisperServerProvider.js"));

const PORT = 18080;
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/inference") {
    let len = 0;
    req.on("data", (d) => { len += d.length; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "hello world from mock whisper", language: "en", confidence: 0.9 }));
    });
    return;
  }
  res.writeHead(404).end();
});

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  console.log("[mock] listening on", PORT);

  process.env.INTERVIA_WHISPER_ENDPOINT = "http://127.0.0.1:" + PORT;
  // Reload config to pick up env.
  delete require.cache[path.join(dist, "main", "config.js")];
  delete require.cache[path.join(dist, "main", "transcription", "providers", "WhisperServerProvider.js")];
  delete require.cache[path.join(dist, "main", "config-types.js")];
  delete require.cache[path.join(dist, "main", "transcription", "providers", "TranscriptionProvider.js")];
  delete require.cache[path.join(dist, "main", "logger.js")];
  const { WhisperServerProvider: WP } = require(path.join(dist, "main", "transcription", "providers", "WhisperServerProvider.js"));
  console.log("endpoint from reloaded config:", require(path.join(dist, "main", "config.js")).config.whisper.endpoint);

  const p = new WP();
  console.log("provider ready:", p.isReady());
  await p.init();
  if (!p.isReady()) { console.log("FAIL provider not ready"); process.exit(1); }
  console.log("PASS provider isReady=true after init()");

  const fakePcm = new Int16Array(16000 * 1); // 1 second
  for (let i = 0; i < fakePcm.length; i++) fakePcm[i] = Math.round(Math.sin((2*Math.PI*440*i/16000))*0.5*32767);
  const r1 = await p.transcribe({ pcm: fakePcm, sampleRate: 16000 });
  console.log("PASS transcribe returned", JSON.stringify(r1));
  if (r1.text !== "hello world from mock whisper") { console.log("FAIL text mismatch"); process.exit(1); }
  if (r1.isFinal !== true) { console.log("FAIL isFinal not true"); process.exit(1); }
  if (r1.confidence !== 0.9) { console.log("FAIL confidence not preserved"); process.exit(1); }

  // Test the partial request path
  const r2 = await p.transcribe({ pcm: fakePcm, sampleRate: 16000, partial: true });
  if (r2.isFinal !== false) { console.log("FAIL partial should produce isFinal=false"); process.exit(1); }
  console.log("PASS partial produces isFinal=false");

  await p.shutdown();
  server.close();
  console.log("ALL MOCK SERVER TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("mock crashed", e); process.exit(2); });