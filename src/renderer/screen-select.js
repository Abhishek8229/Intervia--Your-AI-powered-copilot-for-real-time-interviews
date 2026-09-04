/* eslint-disable */
// Manual region selector: drag a rectangle, release to capture, Esc to cancel.
const api = window.intervia;
const rect = document.getElementById("rect");

let startX = 0;
let startY = 0;
let dragging = false;

function draw(x, y) {
  const rx = Math.min(startX, x);
  const ry = Math.min(startY, y);
  const rw = Math.abs(x - startX);
  const rh = Math.abs(y - startY);
  rect.style.display = "block";
  rect.style.left = rx + "px";
  rect.style.top = ry + "px";
  rect.style.width = rw + "px";
  rect.style.height = rh + "px";
}

document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  draw(startX, startY);
});

document.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  draw(e.clientX, e.clientY);
});

document.addEventListener("mouseup", (e) => {
  if (!dragging) return;
  dragging = false;
  const x = Math.min(startX, e.clientX);
  const y = Math.min(startY, e.clientY);
  const w = Math.abs(e.clientX - startX);
  const h = Math.abs(e.clientY - startY);
  rect.style.display = "none";
  // Tiny drags are treated as accidental: cancel with no side effects.
  if (w < 8 || h < 8) {
    api.selectCancelled();
    return;
  }
  // Account for window offset on multi-monitor setups. Coordinates are in DIP
  // (CSS pixels); main maps them to physical pixels via the display scaleFactor.
  const ox = window.screenX || 0;
  const oy = window.screenY || 0;
  api.regionSelected({ x: Math.round(x + ox), y: Math.round(y + oy), width: Math.round(w), height: Math.round(h), dpr: window.devicePixelRatio || 1 });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    api.selectCancelled();
  }
});
