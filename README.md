# Signal K Dead Reckoning

An offline-first dead reckoning and sensor fusion engine for Signal K that maintains a continuously computed "shadow boat" position from water-track sensors (speed through water, compass heading, and learned leeway and current corrections), so you always have a navigational fallback when GPS becomes unreliable — whether from jamming, spoofing, or plain receiver failure. While GPS is trusted, the engine learns vessel-specific calibration corrections against ground truth and watches for GPS anomalies; when it isn't, the same learned model keeps the dead-reckoned position, its uncertainty polygon, and a water-track log going. Fixes from celestial sights, compass bearings, radar ranges, vertical angles, and horizontal sextant angles are entered through a unified pipeline and can snap dead reckoning back on track, with optional write-through to the vessel's logbook (any Signal K `logentries` resource provider, such as `signalk-logbook`). The whole toolset — sight entry, fix resolution, chartwork, override control — also runs inside [Freeboard-SK](https://github.com/SignalK/freeboard-sk) as a plotter extension, so you can work without leaving the plotter.

**Note:** This is just a toy. Make your own navigation calculations and decisions.

## Why

Planning for life without GPS is no longer hypothetical: the UK Maritime and Coastguard Agency's [Guidance Note 719](https://www.gov.uk/government/publications/mgn-719-mf-operating-in-gnss-denied-and-degraded-environments/mgn-719-mf-operating-in-gnss-denied-and-degraded-environments) ([reported by Yachting Monthly](https://www.yachtingmonthly.com/news/mca-tells-maritime-sector-to-plan-for-life-without-gps-106566), 1 Oct 2026) reports a marked increase in GNSS jamming and spoofing worldwide and asks mariners to review contingency arrangements, maintain resilient navigation practices, and practice navigating without satellite positioning — naming dead reckoning, visual bearings, and celestial fixing as valid methods. This plugin implements a contingency for Signal K vessels.

## Requirements

* This plugin installed and configured
* Some chart source available to Signal K
* Hand bearing compass and/or sextant
* A heading source independent of GNSS — a fluxgate or inertial compass feeding `navigation.headingMagnetic`, not a satellite (GNSS) compass. A satellite compass shares the jamming and spoofing failure mode of the position fix, so a vessel whose only heading source is satellite-derived cannot dead-reckon through GNSS denial. Be careful checking this: on N2K networks a single physical device often provides both compass and position data, and display list entries do not necessarily reflect that (a device may publish both PGN 127257 heading and PGN 129029 position under one source)

## Getting started

1. Install the plugin from the Signal K Appstore (or `npm install @meri-imperiumi/signalk-dead-reckoning`) and enable it. The defaults are sane — you only need to revisit the configuration if you want to change intervals or integrations.
2. Make sure the required data feeds are available on the vessel network:
   * `navigation.position` (GPS) — the training baseline and anomaly reference
   * `navigation.speedThroughWater` (paddlewheel log) and `navigation.headingMagnetic` (compass + variation) — the water-track inputs
   * Wind data — used by the calibration model and the polar speed fallback
3. Just sail. While GPS is reliable and you're under sail (propulsion stopped), the engine continuously learns vessel-specific leeway and speed-loss corrections against GPS ground truth. There is nothing to activate: the "shadow boat" runs at all times, and the uncertainty polygon tightens over a season as the calibration bins fill up. Early on, expect conservative uncertainty estimates.
4. Optional integrations, configured in the plugin settings:
   * `signalk-logbook` (or any other `logentries` resource provider) — writes confirmed fixes and maneuvers to the vessel's logbook
   * `signalk-polar-performance-plugin` — polar-derived speed when the paddlewheel is fouled or silent
   * `@meri-imperiumi/signalk-autostate` — keeps the navigation state (anchored, sailing, motoring) accurate, which gates training
   * [speedandcurrent](https://github.com/Asw1n/speedandcurrent) — learns a heel- and speed-aware paddlewheel correction table and publishes the resulting `navigation.leewayAngle` and current estimate. While GPS is trusted, its Kalman-smoothed leeway gives the DR training pipeline a second, independently modeled opinion on the lateral water-track residual; its own learned table keeps publishing during GPS denial, covering the same physics from a different estimator. If both plugins correct `navigation.speedThroughWater`, set the Signal K source priority for one of them so a single calibrated source wins.
   * Signal K Weather API — point-forecast current vectors for the DR solution

## Daily use

Open the webapp from your Signal K server's *Web apps* menu. It shows the vessel and the shadow boat on the chart, GPS↔DR divergence, the uncertainty polygon, and the water-track log. The same tools are available inside Freeboard-SK — see *In Freeboard-SK* below.

### In Freeboard-SK

With this plugin installed and enabled, [Freeboard-SK](https://github.com/SignalK/freeboard-sk) discovers it as a plotter extension — no extra configuration. What you get depends on the Freeboard version:

* **any version** — the shadow boat itself: enable *Show the DR shadow boat on chart plotters* in the plugin configuration and the DR position is published as a synthetic vessel (labelled *DR Shadow* by default), so the plotter renders it alongside your own vessel with a projected COG line — on Freeboard-SK it shows as a green buddy target
* **≥ 3.0** — a *Dead Reckoning* status tile for the widget grid: GPS↔DR divergence, uncertainty radius and DR health at a glance (place it by pressing and holding an empty widget spot)
* **≥ 3.3** — a *DR Sight / Fix* floating window with the full sight entry, pending-observations list and fix resolution, opened from a toolbar button (or a drawer on small screens), plus *Engage/Release DR override* toolbar buttons that follow the engine state
* **≥ 3.4** — the *DR chartwork* map layer, drawn by Freeboard itself above routes and waypoints but never covering your own vessel, AIS targets or alarms: the DR ghost track, uncertainty circle, lines and circles of position, confirmed fixes, snap-to-fix vectors and the live DR position. It can be shown, hidden and faded in the chart list's *Plugin layers*, follows night mode, and comes with chart-driven sight entry — right-click a charted object for *Bearing sight of this*, *Radar range to this* and friends (coordinates and the object's charted name pre-filled), and right-click an unresolved position line to edit it

The standalone webapp stays unchanged — both front ends read the same engine and can be used side by side.

**Entering fixes.** Open *⊕ Sight / LOP* in the webapp, or the *DR Sight / Fix* window in Freeboard, and pick the method:

* **Bearing** — bearing to a known object (lighthouse, tower) gives a line of position; the instrument selector records whether it came from a hand-bearing compass or the radar
* **Vert. Angle** — vertical angle to a known object of known height gives a circular position line
* **Radar** — range to a known object gives a circular position line — the one ranging instrument that does not depend on GNSS. Range + bearing to the same object is the classic two-instrument radar fix. A range to an AIS target rests on the target's own GNSS-derived position, so under suspected interference prefer charted fixed objects
* **H. Angle** — horizontal sextant angle between two charted objects gives a circle of position with no compass involved; a second angle to a third object gives the classic three-point fix
* **Celestial** — sextant sight of the Sun, Moon, or an almanac star

You can right-click an object on the map to pre-fill its coordinates. Sights can be entered with a stopwatch delay ("minutes ago") instead of clock time. Observations accumulate in the pending list; select two or more, *Preview selected* to resolve the candidate fix, then *Confirm fix* to snap dead reckoning to it. A single line of position can also be advanced to a later sight (running fix).

**When GPS looks wrong.** The plugin raises notifications for GPS anomalies, growing DR divergence, and paddlewheel fouling — but it never switches navigational authority by itself. If you decide to trust DR over GPS, press *Engage OVERRIDE*; the shadow boat takes over `navigation.position` instantly (it has been running all along). Release it when position is re-established, e.g. after confirming a fix.

**Other controls.** *≋ Current* sets a manual set-and-drift override with a TTL, which outranks the automatic current sources while it lasts.
