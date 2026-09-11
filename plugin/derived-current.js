/**
 * Derived current from the boat's own GPS-vs-water-track residual
 * (SPEC §6.2 tier 2).
 *
 * While GPS is trusted, every position fix minus the water-track
 * displacement is a direct observation of the current vector. An
 * exponentially-weighted mean of these residuals — updated whenever a
 * GPS fix and a usable water track coexist — tracks the real ocean
 * current far better than the model products (sea trial
 * 2026-08-30→09-05, Aitutaki→Niue: EWMA tier held DR within ~11 nm
 * over 622 nm vs 47 nm for the tier-3 weather API and 85 nm for the
 * zero vector).
 *
 * When GPS degrades (jamming, spoofing, the Red Sea case) the state
 * carries forward with exponential decay until its TTL lapses, at
 * which point the §6.2 resolver falls through to the model tiers. The
 * update gates are deliberately conservative: only sample when the
 * water track carries direction (STW above the usability floor), only
 * accept residuals within ocean-current bounds (a 3+ kn "current" is a
 * GPS glitch or a lagoon transit, not an observation to learn from).
 *
 * Pure logic over an explicit state object — unit-testable without
 * Signal K plumbing. The plugin entry point samples it once per tick
 * with the latest GPS fix and water track, and reads a snapshot for
 * the resolver.
 *
 * @file derived-current.js
 */

/** Minimum seconds between GPS fixes used for ground-vector sampling. */
const MIN_GPS_INTERVAL_S = 5;

/** STW (kn) above which the water track carries usable direction. */
const MIN_STW_KN = 1.0;

/** Residual magnitude (kn) above which a sample is discarded as a glitch. */
const MAX_RESIDUAL_KN = 3.0;

/** SOG (kn) above which a GPS displacement is a glitch, not sailing. */
const MAX_SOG_KN = 60;

/** EWMA time constant (s) for residual samples (sea-trial-validated 6 h). */
const TAU_S = 6 * 3600;

/** Carry decay time constant (s) once GPS sampling stops. */
const CARRY_TAU_S = 24 * 3600;

/** How long (ms) after the last sample the snapshot stays valid. */
const MAX_AGE_MS = 24 * 3600 * 1000;

/** Samples required before the snapshot resolves (below: not a current). */
const MIN_SAMPLES = 10;

/**
 * Creates the derived-current state.
 *
 * @returns {{lastGps: {latitude:number, longitude:number, tMs:number}|null,
 *   uKn: number, vKn: number, lastSampleMs: number, sampleCount: number}}
 */
function createDerivedCurrentState() {
  return {
    lastGps: null,
    uKn: 0,
    vKn: 0,
    lastSampleMs: 0,
    sampleCount: 0,
  };
}

/**
 * Feeds one tick's sensors into the EWMA. The ground vector comes from
 * consecutive GPS fixes (position-differential SOG/COG — the ground
 * truth, per the calibration report §7); the water vector from STW and
 * true heading. Both must be present and sane for a sample; the stored
 * fix refreshes either way so the next differential starts here.
 *
 * @param {object} st - state from {@link createDerivedCurrentState}
 * @param {object} s - per-tick snapshot
 * @param {number} s.tMs - epoch ms of this tick
 * @param {{latitude:number, longitude:number}|null} s.gps - latest GPS fix
 * @param {number|null} s.stwKn - speed through water (kn)
 * @param {number|null} s.headingTrueDeg - true heading (deg [0,360))
 * @returns {{sampled: boolean, reason: string|null}} why no sample was
 *   taken, when it wasn't
 */
function updateDerivedCurrent(st, s) {
  if (!s.gps) return { sampled: false, reason: "no-gps" };
  const dtS = (s.tMs - (st.lastGps?.tMs ?? 0)) / 1000;
  const prev = st.lastGps;
  st.lastGps = {
    latitude: s.gps.latitude,
    longitude: s.gps.longitude,
    tMs: s.tMs,
  };
  if (!prev || dtS < MIN_GPS_INTERVAL_S) {
    return { sampled: false, reason: "interval" };
  }
  if (s.stwKn == null || s.stwKn < MIN_STW_KN) {
    return { sampled: false, reason: "stw" };
  }
  if (s.headingTrueDeg == null || !Number.isFinite(s.headingTrueDeg)) {
    return { sampled: false, reason: "heading" };
  }

  const rad = Math.PI / 180;
  const latAvg = ((prev.latitude + s.gps.latitude) / 2) * rad;
  const meanLatNm = (s.gps.latitude - prev.latitude) * 60;
  const eastNm = (s.gps.longitude - prev.longitude) * 60 * Math.cos(latAvg);
  const distNm = Math.hypot(meanLatNm, eastNm);
  const sogKn = distNm / (dtS / 3600);
  if (sogKn > MAX_SOG_KN) {
    return { sampled: false, reason: "gps-glitch" };
  }
  const cogDeg =
    distNm > 1e-9 ? (Math.atan2(eastNm, meanLatNm) * 180) / Math.PI : 0;

  // Residual = ground velocity − water velocity, in kn components
  // (u = east, v = north).
  const u =
    sogKn * Math.sin(cogDeg * rad) - s.stwKn * Math.sin(s.headingTrueDeg * rad);
  const v =
    sogKn * Math.cos(cogDeg * rad) - s.stwKn * Math.cos(s.headingTrueDeg * rad);
  if (Math.hypot(u, v) > MAX_RESIDUAL_KN) {
    return { sampled: false, reason: "residual-outlier" };
  }

  if (st.sampleCount === 0) {
    st.uKn = u;
    st.vKn = v;
  } else {
    // Continuous-time first-order filter: alpha from the sample gap.
    const alpha = 1 - Math.exp(-dtS / TAU_S);
    st.uKn += (u - st.uKn) * alpha;
    st.vKn += (v - st.vKn) * alpha;
  }
  st.sampleCount += 1;
  st.lastSampleMs = s.tMs;
  return { sampled: true, reason: null };
}

/**
 * Snapshot for the §6.2 resolver. The drift magnitude decays with the
 * age of the last sample (current persistence is hours, not days); the
 * TTL bounds it outright, after which the resolver falls through to the
 * model tiers.
 *
 * @param {object} st - state from {@link createDerivedCurrentState}
 * @param {number} nowMs - epoch ms
 * @returns {{setTrue: number, drift: number, validUntilMs: number}|null}
 *   setTrue in deg true (direction the current flows toward), drift in
 *   kn; null when there is no usable derived current yet
 */
function derivedCurrentSnapshot(st, nowMs) {
  if (st.sampleCount < MIN_SAMPLES) return null;
  const ageMs = nowMs - st.lastSampleMs;
  if (ageMs < 0 || ageMs > MAX_AGE_MS) return null;
  const drift =
    Math.hypot(st.uKn, st.vKn) * Math.exp(-ageMs / (CARRY_TAU_S * 1000));
  if (!Number.isFinite(drift) || drift < 1e-6) {
    return { setTrue: 0, drift: 0, validUntilMs: st.lastSampleMs + MAX_AGE_MS };
  }
  const setTrue =
    ((((Math.atan2(st.uKn, st.vKn) * 180) / Math.PI) % 360) + 360) % 360;
  return { setTrue, drift, validUntilMs: st.lastSampleMs + MAX_AGE_MS };
}

module.exports = {
  createDerivedCurrentState,
  updateDerivedCurrent,
  derivedCurrentSnapshot,
  // tunables exported for tests
  MIN_GPS_INTERVAL_S,
  MIN_STW_KN,
  MAX_RESIDUAL_KN,
  MAX_SOG_KN,
  TAU_S,
  CARRY_TAU_S,
  MAX_AGE_MS,
  MIN_SAMPLES,
};
