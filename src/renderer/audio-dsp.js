/* eslint-disable */
// Intervia capture DSP helpers — pure functions, no DOM, no Electron, no I/O.
//
// Loaded by audio-capture.html BEFORE audio-capture.js (browser global
// `AudioDsp`) AND required directly by plain-Node verify scripts
// (module.exports). Single canonical implementation used by both the live
// pipeline and the deterministic tests — no duplicated math.
//
// All functions operate on Float32 PCM in [-1, 1] (what Web Audio
// AudioBuffers provide) unless the name says Int16. Only scalar statistics
// ever leave these functions — never raw audio.

(function (root) {
  "use strict";

  var DB_FLOOR = -60;
  var FLOOR_AMP = 0.001; // 20*log10(0.001) === -60

  function toFiniteNumber(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Clamp a sample to [-1, 1]; non-finite samples become 0 (silence). */
  function clampSample(v) {
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    if (n > 1) return 1;
    if (n < -1) return -1;
    return n;
  }

  /**
   * Average multi-channel Float32 frames to mono. Empty/missing input yields
   * an empty frame (callers map that to the silence floor — never NaN).
   */
  function downmixToMono(channels) {
    if (!channels || channels.length === 0) return new Float32Array(0);
    var first = channels[0] || [];
    var len = first.length || 0;
    if (channels.length === 1) {
      var solo = new Float32Array(len);
      for (var i = 0; i < len; i++) solo[i] = clampSample(first[i]);
      return solo;
    }
    var out = new Float32Array(len);
    for (var j = 0; j < len; j++) {
      var sum = 0;
      for (var c = 0; c < channels.length; c++) {
        sum += clampSample((channels[c] || [])[j]);
      }
      out[j] = sum / channels.length;
    }
    return out;
  }

  /** Linear resampler for Float32 mono frames (identity when rates match). */
  function resampleLinear(input, fromRate, toRate) {
    var src = input || [];
    if (!fromRate || !toRate || fromRate === toRate) {
      return src instanceof Float32Array ? src : Float32Array.from(src, clampSample);
    }
    var ratio = fromRate / toRate;
    if (!Number.isFinite(ratio) || ratio <= 0) return new Float32Array(0);
    var outLen = Math.floor(src.length / ratio);
    var out = new Float32Array(Math.max(0, outLen));
    for (var i = 0; i < out.length; i++) {
      var idx = i * ratio;
      var i0 = Math.floor(idx);
      var i1 = Math.min(i0 + 1, src.length - 1);
      var t = idx - i0;
      out[i] = clampSample(src[i0]) * (1 - t) + clampSample(src[i1]) * t;
    }
    return out;
  }

  /** Float32 [-1,1] mono -> Int16 PCM (transport encoding only). */
  function floatToInt16PCM(input) {
    var src = input || [];
    var out = new Int16Array(src.length);
    for (var i = 0; i < src.length; i++) {
      var s = clampSample(src[i]);
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  /**
   * Frame statistics from Float32 mono samples:
   *   rms  = sqrt(sum(x^2)/N)          (0 for empty/silent)
   *   peak = max(|x|)                  (0 for empty/silent)
   *   db   = 20*log10(max(rms, eps))   (floor -60 dB, never -Inf/NaN)
   * Returns plain numbers only.
   */
  function computeFrameStats(monoFloat) {
    var src = monoFloat || [];
    var n = src.length || 0;
    if (n === 0) return { rms: 0, peak: 0, db: DB_FLOOR };
    var sum = 0;
    var peak = 0;
    for (var i = 0; i < n; i++) {
      var s = clampSample(src[i]);
      sum += s * s;
      var a = s < 0 ? -s : s;
      if (a > peak) peak = a;
    }
    var rms = Math.sqrt(sum / n);
    if (!Number.isFinite(rms)) rms = 0;
    if (!Number.isFinite(peak)) peak = 0;
    var amp = rms > FLOOR_AMP ? rms : FLOOR_AMP;
    var db = 20 * Math.log10(amp);
    if (!Number.isFinite(db)) db = DB_FLOOR;
    if (db < DB_FLOOR) db = DB_FLOOR;
    if (db > 0) db = 0;
    return { rms: rms, peak: peak, db: db };
  }

  /** Peak amplitude of an Int16 PCM frame as 0..1 (transport-domain check). */
  function pcmPeak(pcm) {
    var src = pcm || [];
    var peak = 0;
    for (var i = 0; i < src.length; i++) {
      var v = toFiniteNumber(src[i]) / 32768;
      var a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    return peak > 1 ? 1 : peak;
  }

  var api = {
    DB_FLOOR: DB_FLOOR,
    clampSample: clampSample,
    downmixToMono: downmixToMono,
    resampleLinear: resampleLinear,
    floatToInt16PCM: floatToInt16PCM,
    computeFrameStats: computeFrameStats,
    pcmPeak: pcmPeak,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.AudioDsp = api;
})(typeof window !== "undefined" ? window : globalThis);
