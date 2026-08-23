/**
 * `<dr-map-view>` — dual/continuous track rendering of GPS vs. the always-on
 * inertial "Ghost Track" (SPEC §14.1).
 *
 * v1 stub: a placeholder canvas that renders headline status text. The
 * full implementation wires OpenLayers/Leaflet for actual track rendering,
 * uncertainty polygon, LOP/CPL primitives, and the snap-to-fix correction
 * vector. The stub exists so the webapp loads and the plugin status REST
 * endpoint can be exercised.
 *
 * @file dr-map-view.js
 */

class DrMapView extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const slot = document.createElement("div");
    slot.setAttribute("part", "canvas");
    slot.style.width = "100%";
    slot.style.height = "100%";
    slot.style.display = "flex";
    slot.style.alignItems = "center";
    slot.style.justifyContent = "center";
    slot.style.color = "var(--dr-muted, #8b949e)";
    slot.textContent = "Map view (OpenLayers integration pending)";
    root.appendChild(slot);

    /** @type {HTMLDivElement} */
    this.canvas = slot;
    this.loadStatus();
  }

  /**
   * Fetches and renders the current DR engine status from the plugin.
   *
   * @returns {Promise<void>}
   */
  async loadStatus() {
    try {
      const res = await fetch("./status");
      if (!res.ok) return;
      const data = await res.json();
      this.render(data);
    } catch {
      // Offline or not started — leave the placeholder.
    }
  }

  /**
   * Renders a status summary into the placeholder.
   *
   * @param {object} data
   * @returns {void}
   */
  render(data) {
    const origin = data.origin
      ? `${data.origin.latitude.toFixed(4)}, ${data.origin.longitude.toFixed(4)}`
      : "no origin";
    this.canvas.textContent = `DR ${data.active ? "OVERRIDE" : "NORMAL"} · ${origin} · ${data.logNm?.toFixed(2) ?? "0"} nm · ${data.binCount ?? 0} bins`;
  }
}

customElements.define("dr-map-view", DrMapView);
