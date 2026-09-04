const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "..", "src", "renderer");
const dests = [
  path.resolve(__dirname, "..", "dist", "renderer"),
  path.resolve(__dirname, "..", "build", "renderer"),
];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function cpdir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name);
    const dp = path.join(d, e.name);
    if (e.isDirectory()) cpdir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

for (const d of dests) {
  rmrf(d);
  cpdir(src, d);
  console.log("[copy-renderer] copied", src, "->", d);
}