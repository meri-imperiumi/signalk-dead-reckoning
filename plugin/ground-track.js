/**
 * Dead-reckoning track history (SPEC §9.1: sun-run-sun / running fix).
 *
 * Holds a short ring buffer of DR position samples
 * (`{timestamp, latitude, longitude}`) and answers the question the
 * running-fix pipeline needs: "what was the vessel's displacement
 * (bearing, distance) between time t0 and time t1?"
 *
 * The buffer is fed **only** from the DR engine's water-track
 * integration (STW + heading + leeway + resolved current). GPS is
 * deliberately excluded: the entire purpose of a celestial running
 * fix is a GPS-independent position check. If the advance used GPS
 * ground track, the "fix" would just be GPS laundered through celestial
 * geometry. For a boat without GPS at all, the DR track is the only
 * available "run"; for a boat without STW/compass either, the buffer
 * stays empty and `displacementBetween` returns null (the pipeline
 * resolves un-advanced — the honest failure rather than a silently
 * wrong advanced fix).
 *
 * The buffer is bounded (default 6 h at 1 Hz = 21 600 samples). Older
 * samples age out.
 *
 * @file ground-track.js
 */

const { distanceNm, bearingDeg } = require("./geo.js");

/**
 * @typedef {{timestamp: number, latitude: number, longitude: number}} Sample
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.capacity=21600] max samples
 */
class GroundTrack {
  constructor(opts = {}) {
    /** @type {Sample[]} */
    this.samples = [];
    /** @type {number} */
    this.capacity = opts.capacity ?? 21600;
  }

  /**
   * Appends a DR position sample. Deduplicated on timestamp (same-ms
   * samples replace, keeping the latest).
   * @param {Sample} sample
   * @returns {void}
   */
  append(sample) {
    if (!Number.isFinite(sample.timestamp)) return;
    if (
      this.samples.length > 0 &&
      this.samples[this.samples.length - 1].timestamp === sample.timestamp
    ) {
      this.samples[this.samples.length - 1] = sample;
      return;
    }
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /**
   * Interpolates the DR position at time `t` (epoch ms). Returns null if
   * `t` is outside the buffered range. Linear interpolation in lat/lon
   * is adequate over the few-second gaps between 1 Hz samples; we do not
   * great-circle-interpolate because the error is sub-meter at that
   * rate.
   * @param {number} t
   * @returns {{latitude: number, longitude: number}|null}
   */
  positionAt(t) {
    const s = this.samples;
    if (s.length === 0) return null;
    if (t < s[0].timestamp || t > s[s.length - 1].timestamp) return null;
    let lo = 0;
    while (lo < s.length - 1 && s[lo + 1].timestamp < t) lo++;
    const a = s[lo];
    const b = s[Math.min(lo + 1, s.length - 1)];
    if (a.timestamp === b.timestamp) {
      return { latitude: a.latitude, longitude: a.longitude };
    }
    const f = (t - a.timestamp) / (b.timestamp - a.timestamp);
    return {
      latitude: a.latitude + (b.latitude - a.latitude) * f,
      longitude: a.longitude + (b.longitude - a.longitude) * f,
    };
  }

  /**
   * DR displacement (bearing true, distance nm) between two epoch-ms
   * timestamps — the inertial "run" between two sights. Returns null
   * if either endpoint is outside the buffered range (no DR history for
   * that span — e.g. a sight taken before the engine started, or a boat
   * without water-track sensors). The pipeline treats null as "cannot
   * advance — resolve un-advanced".
   * @param {number} t0
   * @param {number} t1
   * @returns {{bearingTrue: number, distanceNm: number}|null}
   */
  displacementBetween(t0, t1) {
    const p0 = this.positionAt(t0);
    const p1 = this.positionAt(t1);
    if (!p0 || !p1) return null;
    const d = distanceNm(p0, p1);
    if (d === 0) return { bearingTrue: 0, distanceNm: 0 };
    return { bearingTrue: bearingDeg(p0, p1), distanceNm: d };
  }

  /** @returns {number} the earliest buffered timestamp, or NaN if empty */
  earliest() {
    return this.samples.length ? this.samples[0].timestamp : Number.NaN;
  }

  /** @returns {number} the latest buffered timestamp, or NaN if empty */
  latest() {
    return this.samples.length
      ? this.samples[this.samples.length - 1].timestamp
      : Number.NaN;
  }
}

module.exports = { GroundTrack };
