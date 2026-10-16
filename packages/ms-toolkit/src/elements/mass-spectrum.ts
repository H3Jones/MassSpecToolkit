import { mountChart } from '@tanstack/charts/dom';
import type { ChartHost } from '@tanstack/charts';
import {
  createMassSpectrumChart,
  copySpectrumPeaks,
  type RelativeSpectrumPeak,
  type SpectrumPeak,
} from '../charts/index.ts';

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host { display: block; min-width: 0; font: inherit; }
    h3 { margin: 0 0 0.75rem; text-align: center; font-size: 1em; }
    [hidden] { display: none !important; }
    .chart { position: relative; min-width: 0; }
    .status { margin: 0.5rem 0; }
    .error { color: #b91c1c; }
  </style>
  <h3 part="title" hidden><slot name="title"></slot></h3>
  <div class="chart" part="chart"></div>
  <p class="status" part="status" role="status">No peaks to display.</p>
`;

/**
 * `<ms-mass-spectrum chart-title="Mass spectrum" height="360">`
 * Assign centroid peaks to `data`. Intensities are normalized to a 100% base peak.
 * Rendering errors dispatch `ms-error` (detail: Error).
 */
export class MsMassSpectrum extends HTMLElement {
  static observedAttributes = ['chart-title', 'height', 'color', 'labels', 'mz-min', 'mz-max', 'x-label'];

  #data: readonly SpectrumPeak[] = [];
  #host?: ChartHost<RelativeSpectrumPeak, number, number>;
  #container!: HTMLElement;
  #title!: HTMLElement;
  #titleSlot!: HTMLSlotElement;
  #status!: HTMLElement;

  get data(): readonly SpectrumPeak[] {
    return this.#data.map((peak) => ({ ...peak }));
  }

  /** Invalid data throws before replacing the current spectrum. */
  set data(peaks: readonly SpectrumPeak[]) {
    this.#data = copySpectrumPeaks(peaks);
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: 'open' });
      root.append(template.content.cloneNode(true));
      this.#container = root.querySelector<HTMLElement>('[part=chart]')!;
      this.#title = root.querySelector<HTMLElement>('[part=title]')!;
      this.#titleSlot = root.querySelector<HTMLSlotElement>('slot[name=title]')!;
      this.#titleSlot.addEventListener('slotchange', () => {
        if (this.isConnected) this.#render();
      });
      this.#status = root.querySelector<HTMLElement>('[part=status]')!;
    }
    // Preserve data assigned before the custom element was registered.
    if (Object.prototype.hasOwnProperty.call(this, 'data')) {
      const peaks = this.data;
      Reflect.deleteProperty(this, 'data');
      this.data = peaks;
      return;
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#host?.destroy();
    this.#host = undefined;
  }

  attributeChangedCallback(): void {
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  #render(): void {
    const fallbackTitle = this.getAttribute('chart-title') ?? '';
    if (this.#titleSlot.textContent !== fallbackTitle) this.#titleSlot.textContent = fallbackTitle;
    const titleNodes = this.#titleSlot.assignedNodes();
    const title = titleNodes.length
      ? titleNodes.map((node) => node.textContent ?? '').join('').trim()
      : fallbackTitle;
    this.#title.hidden = !title;

    try {
      const heightAttribute = this.getAttribute('height');
      const height = heightAttribute === null ? 360 : Number(heightAttribute);
      if (!Number.isFinite(height) || height <= 0) {
        throw new RangeError('Spectrum height must be a finite, positive number.');
      }
      const labelsAttribute = this.getAttribute('labels');
      if (labelsAttribute !== null && !['', 'true', 'false'].includes(labelsAttribute)) {
        throw new TypeError('Spectrum labels must be "true" or "false".');
      }
      const minimumMz = this.getAttribute('mz-min');
      const maximumMz = this.getAttribute('mz-max');
      let mzDomain: readonly [number, number] | undefined;
      if (minimumMz !== null || maximumMz !== null) {
        if (minimumMz === null || maximumMz === null || !minimumMz.trim() || !maximumMz.trim()) {
          throw new RangeError('Set both mz-min and mz-max to specify the spectrum m/z range.');
        }
        mzDomain = [Number(minimumMz), Number(maximumMz)];
      }
      const definition = createMassSpectrumChart(this.#data, {
        color: this.getAttribute('color') ?? undefined,
        labels: labelsAttribute !== 'false',
        mzDomain,
        xLabel: this.getAttribute('x-label') ?? undefined,
      });
      if (this.#data.length === 0) {
        this.#host?.destroy();
        this.#host = undefined;
        this.#status.className = 'status';
        this.#status.textContent = 'No peaks to display.';
        this.#status.hidden = false;
        return;
      }
      const options = {
        definition,
        height,
        initialWidth: 640,
        ariaLabel: title || 'Mass spectrum',
        ariaDescription: `${this.#data.length} peaks. Intensities normalized to the base peak at 100%.`,
      };
      if (this.#host) {
        this.#host.update(options);
      } else {
        this.#host = mountChart(this.#container, options);
      }
      this.#status.hidden = true;
    } catch (error) {
      this.#host?.destroy();
      this.#host = undefined;
      this.#container.replaceChildren();
      const err = error instanceof Error ? error : new Error(String(error));
      this.#status.className = 'status error';
      this.#status.textContent = err.message;
      this.#status.hidden = false;
      this.dispatchEvent(new CustomEvent('ms-error', { detail: err, bubbles: true }));
    }
  }
}

if (!customElements.get('ms-mass-spectrum')) {
  customElements.define('ms-mass-spectrum', MsMassSpectrum);
}

declare global {
  interface HTMLElementTagNameMap {
    'ms-mass-spectrum': MsMassSpectrum;
  }
}
