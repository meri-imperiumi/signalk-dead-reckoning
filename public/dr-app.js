/**
 * `<dr-app>` — top-level layout for the Dead Reckoning webapp.
 *
 * Composes the map view, headline figures, and the manual OVERRIDE control
 * (SPEC §14.1: prominent, always human-initiated). Uses the Signal K
 * stream subscription component for live updates.
 *
 * @file dr-app.js
 */

const template = document.createElement("template");
template.innerHTML = /* html */ `
  <section class="dr-panel dr-headline">
    <div class="dr-figure">
      <span class="value" id="dr-log">— nm</span>
      <span class="label">Water-track log</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-elapsed">—</span>
      <span class="label">Since last fix</span>
    </div>
    <div class="dr-figure">
      <span class="value" id="dr-method">—</span>
      <span class="label">Active method</span>
    </div>
  </section>

  <section class="dr-panel">
    <h2>Ghost Track</h2>
    <dr-map-view id="dr-map"></dr-map-view>
  </section>

  <section class="dr-panel dr-override">
    <h2>Failover Control</h2>
    <button id="dr-override-btn">Engage OVERRIDE</button>
    <span id="dr-override-state">NORMAL (GPS authoritative)</span>
  </section>
`;

class DrApp extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    root.appendChild(template.content.cloneNode(true));

    /** @type {HTMLButtonElement|null} */
    this.btn = root.querySelector("#dr-override-btn");
    /** @type {HTMLElement|null} */
    this.stateLabel = root.querySelector("#dr-override-state");
    this.btn?.addEventListener("click", () => this.toggleOverride());
  }

  /**
   * Toggles the manual NORMAL ↔ OVERRIDE switch via the plugin REST API.
   * Always human-initiated (SPEC §7, §14.1).
   *
   * @returns {Promise<void>}
   */
  async toggleOverride() {
    const active = !this.btn?.classList.contains("engaged");
    try {
      const res = await fetch("./override", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.renderOverride(data.active);
    } catch (err) {
      console.error("override toggle failed", err);
    }
  }

  /**
   * Renders the override button/label state.
   *
   * @param {boolean} active
   * @returns {void}
   */
  renderOverride(active) {
    if (!this.btn || !this.stateLabel) return;
    this.btn.classList.toggle("engaged", active);
    this.btn.textContent = active ? "Release OVERRIDE" : "Engage OVERRIDE";
    this.stateLabel.textContent = active
      ? "OVERRIDE (DR authoritative)"
      : "NORMAL (GPS authoritative)";
  }
}

customElements.define("dr-app", DrApp);
