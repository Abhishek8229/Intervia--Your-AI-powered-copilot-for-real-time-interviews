/**
 * Runtime tray icon for Intervia (no image assets in the repo).
 *
 * Builds a 16x16 PNG (blue rounded square with a white mic-ish bar) purely
 * with node:zlib + a small CRC32, then hands it to Electron's nativeImage.
 * Pure functions (encodePng, crc32) are deterministic and unit-tested
 * headless; only createTrayNativeImage touches Electron.
 */

import * as zlib from "zlib";

const SIZE = 16;

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}

const TABLE = crcTable();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

/** 16x16 RGBA pixels: Intervia blue square, white center bar. Exported for tests. */
export function trayPixels(): Buffer {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      const inBar = x >= 7 && x <= 8 && y >= 3 && y <= 12;
      const inBase = y >= 11 && y <= 12 && x >= 5 && x <= 10;
      if (inBar || inBase) {
        px[o] = 255; px[o + 1] = 255; px[o + 2] = 255; px[o + 3] = 255;
      } else {
        px[o] = 37; px[o + 1] = 99; px[o + 2] = 235; px[o + 3] = 255;
      }
    }
  }
  return px;
}

/** Minimal PNG encoder (8-bit RGBA, no interlace). Deterministic. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) throw new Error("bad pixel buffer");
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    header,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Electron NativeImage for the tray (throws only if Electron is missing). */
export function createTrayNativeImage(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { nativeImage } = require("electron");
  const png = encodePng(SIZE, SIZE, trayPixels());
  const img = nativeImage.createFromBuffer(png);
  return img;
}
