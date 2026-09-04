import * as path from "path";
import { logger } from "../logger";

/**
 * Windows capture-exclusion using SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE.
 * Uses koffi to call user32.dll directly. No native compilation required.
 *
 * Gracefully no-ops on non-Windows platforms.
 */

let lib: any = null;
let proc: any = null;
let initTried = false;
let initFailed = false;

const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

function tryInit(): boolean {
  if (initTried) return !initFailed;
  initTried = true;
  if (process.platform !== "win32") {
    initFailed = true;
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require("koffi");
    lib = koffi.load("user32.dll");
    proc = lib.func("__stdcall", "SetWindowDisplayAffinity", "bool", ["void *", "uint32"]);
    return true;
  } catch (e) {
    logger.warn("native capture-exclusion init failed", String(e));
    initFailed = true;
    return false;
  }
}

export interface CaptureExclusionResult {
  supported: boolean;
  applied: boolean;
  reason: string;
}

export function setWindowDisplayAffinity(hwnd: number | null, mode: "exclude" | "monitor" | "none" = "exclude"): CaptureExclusionResult {
  if (!tryInit()) {
    return { supported: false, applied: false, reason: "native-not-available" };
  }
  if (hwnd == null || hwnd === 0) {
    return { supported: true, applied: false, reason: "invalid-hwnd" };
  }
  const flag = mode === "exclude" ? WDA_EXCLUDEFROMCAPTURE : mode === "monitor" ? WDA_MONITOR : WDA_NONE;
  try {
    const ok = proc(hwnd, flag);
    if (!ok) {
      return { supported: true, applied: false, reason: "SetWindowDisplayAffinity returned false" };
    }
    return { supported: true, applied: true, reason: "ok" };
  } catch (e) {
    return { supported: true, applied: false, reason: "exception:" + String(e) };
  }
}

export const CAPTURE_EXCLUSION_FLAGS = {
  WDA_NONE,
  WDA_MONITOR,
  WDA_EXCLUDEFROMCAPTURE,
};

export function isCaptureExclusionSupported(): boolean {
  return tryInit() && !initFailed;
}