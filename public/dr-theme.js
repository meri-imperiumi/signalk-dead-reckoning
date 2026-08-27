/**
 * Shared "tactical sci-fi" theme styles for the DR web components.
 *
 * Each component renders inside its own shadow root, so document-level
 * CSS can't reach its internals — but CSS custom properties pierce the
 * boundary. The tokens (`--bg-panel`, `--color-teal`, …) are declared
 * at the document `:root` (styles.css); the fallbacks here keep the
 * components legible if loaded standalone.
 *
 * Rules implemented here (Lille Ø Signal K UI spec): flat geometry
 * (border-radius 0, no shadows/gradients), 2px corner brackets via
 * pseudo-elements, faint inner panel borders, hardware-style controls
 * (transparent with theme borders, inverted on use, ≥48px touch
 * targets), 2px-bottom-rule monospace inputs, and the `.theme-*`
 * semantic classes that swap `--theme-color`/`--theme-color-rgb`.
 *
 * @file dr-theme.js
 */

export const THEME_CSS = `
  /* Semantic theme classes (host element or any inner node) */
  .theme-green, :host(.theme-green) {
    --theme-color: var(--color-green, #6b9e78);
    --theme-color-rgb: var(--color-green-rgb, 107, 158, 120);
  }
  .theme-teal, :host(.theme-teal) {
    --theme-color: var(--color-teal, #4b8b99);
    --theme-color-rgb: var(--color-teal-rgb, 75, 139, 153);
  }
  .theme-orange, :host(.theme-orange) {
    --theme-color: var(--color-orange, #c77b28);
    --theme-color-rgb: var(--color-orange-rgb, 199, 123, 40);
  }
  .theme-red, :host(.theme-red) {
    --theme-color: var(--color-red, #c94b4b);
    --theme-color-rgb: var(--color-red-rgb, 201, 75, 75);
  }
  .theme-offline, :host(.theme-offline) {
    --theme-color: var(--color-grey, #444444);
    --theme-color-rgb: var(--color-grey-rgb, 68, 68, 68);
  }

  :host {
    --theme-color: var(--color-green, #6b9e78);
    --theme-color-rgb: var(--color-green-rgb, 107, 158, 120);
    font-family: system-ui, -apple-system, sans-serif;
    color: var(--text-main, #ffffff);
  }
  :host(.theme-teal) {
    --theme-color: var(--color-teal, #4b8b99);
    --theme-color-rgb: var(--color-teal-rgb, 75, 139, 153);
  }
  :host(.theme-orange) {
    --theme-color: var(--color-orange, #c77b28);
    --theme-color-rgb: var(--color-orange-rgb, 199, 123, 40);
  }
  :host(.theme-red) {
    --theme-color: var(--color-red, #c94b4b);
    --theme-color-rgb: var(--color-red-rgb, 201, 75, 75);
  }
  :host(.theme-offline) {
    --theme-color: var(--color-grey, #444444);
    --theme-color-rgb: var(--color-grey-rgb, 68, 68, 68);
  }

  /* Panels ("sk-card"): flat card with hardware mounting brackets */
  .sk-card {
    position: relative;
    background: var(--bg-panel, #111414);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .sk-card::before,
  .sk-card::after {
    content: "";
    position: absolute;
    width: 12px;
    height: 12px;
    border: 2px solid var(--theme-color);
    pointer-events: none;
  }
  .sk-card::before {
    top: -2px;
    left: -2px;
    border-right: none;
    border-bottom: none;
  }
  .sk-card::after {
    bottom: -2px;
    right: -2px;
    border-left: none;
    border-top: none;
  }

  /* Headers: small, bold, uppercase, tracked, theme-colored */
  h2 {
    margin: 0 0 0.75rem 0;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--theme-color);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  h2 button {
    padding: 0 0.75rem;
    flex: 0 0 auto;
    margin-left: auto;
  }

  /* Buttons: hardware inputs — transparent, theme border, invert on use */
  button {
    appearance: none;
    font-family: ui-monospace, "Fira Code", monospace;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 1;
    background: transparent;
    color: var(--theme-color);
    border: 1px solid var(--theme-color);
    border-radius: 0;
    padding: 0 1rem;
    min-height: 48px;
    min-width: 48px;
    cursor: pointer;
    transition: background-color 120ms, color 120ms;
  }
  button:hover:not(:disabled),
  button:active:not(:disabled) {
    background: var(--theme-color);
    color: var(--bg-base, #080a0c);
  }
  button:disabled {
    border-color: var(--color-grey, #444444);
    color: var(--color-grey, #444444);
    cursor: not-allowed;
  }

  /* Inputs: transparent, solid 2px bottom rule, monospace payload */
  input,
  select,
  textarea {
    appearance: none;
    background: transparent;
    border: none;
    border-bottom: 2px solid var(--color-grey, #444444);
    border-radius: 0;
    color: var(--text-main, #ffffff);
    font-family: ui-monospace, "Fira Code", monospace;
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
    padding: 0.35rem 0.3rem;
    min-height: 48px;
    box-sizing: border-box;
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-bottom-color: var(--theme-color);
  }
  select option {
    background: var(--bg-panel, #111414);
    color: var(--text-main, #ffffff);
  }

  /* Toggles/checkboxes: sharp squares — fill means ON */
  input[type="checkbox"] {
    appearance: none;
    width: 1.4rem;
    height: 1.4rem;
    min-height: 1.4rem;
    padding: 0;
    border: 1px solid var(--color-grey, #444444);
    cursor: pointer;
  }
  input[type="checkbox"]:checked {
    background: var(--theme-color);
    border-color: var(--theme-color);
  }

  /* Semantic status text */
  .error {
    color: var(--color-red, #c94b4b);
  }
  .warn {
    color: var(--color-orange, #c77b28);
  }

  :focus-visible {
    outline: 1px dashed var(--color-teal, #4b8b99);
    outline-offset: 2px;
  }
`;
