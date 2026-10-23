import { init, use, type EChartsType } from "echarts/core";
import { CustomChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import {
  createMassSpectrumChart,
  copySpectrumPeaks,
  normalizeSpectrumPeaks,
  type SpectrumPeak,
} from "../charts/index.ts";
import { getAutomaticMzDomain } from "../charts/mass-spectrum.ts";
import { createSpectrumTooltip } from "../charts/spectrum-tooltip.ts";

use([
  CustomChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  ToolboxComponent,
  TooltipComponent,
  SVGRenderer,
]);

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host { display: block; min-width: 0; font: inherit; }
    h3 { margin: 0 0 0.75rem; text-align: center; font-size: 1em; }
    [hidden] { display: none !important; }
    .chart-frame { position: relative; min-width: 0; }
    .chart { min-width: 0; }
    .status { margin: 0.5rem 0; }
    .error { color: #b91c1c; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  </style>
  <h3 part="title" hidden><slot name="title"></slot></h3>
  <div class="chart-frame" part="chart-frame">
    <div class="chart" part="chart" tabindex="0" role="region"></div>
  </div>
  <p class="status" part="status" role="status">No peaks to display.</p>
  <p class="sr-only" part="peak-announcement" role="status" aria-live="polite"></p>
`;

/**
 * `<ms-mass-spectrum chart-title="Mass spectrum" height="360">`
 * Assign centroid peaks to `data`. Intensities are normalized to a 100% base peak.
 * Rendering errors dispatch `ms-error` (detail: Error).
 */
export class MsMassSpectrum extends HTMLElement {
  static observedAttributes = [
    "chart-title",
    "height",
    "color",
    "labels",
    "mz-min",
    "mz-max",
    "x-label",
  ];

  #data: readonly SpectrumPeak[] = [];
  #host?: EChartsType;
  #resizeObserver?: ResizeObserver;
  #container!: HTMLElement;
  #title!: HTMLElement;
  #titleSlot!: HTMLSlotElement;
  #status!: HTMLElement;
  #announcement!: HTMLElement;
  #activePeak = -1;
  #zoomDomain?: readonly [number, number];
  #defaultMzDomain?: readonly [number, number];

  get data(): readonly SpectrumPeak[] {
    return this.#data.map((peak) => ({ ...peak }));
  }

  /** Invalid data throws before replacing the current spectrum. */
  set data(peaks: readonly SpectrumPeak[]) {
    this.#data = copySpectrumPeaks(peaks);
    this.#zoomDomain = undefined;
    this.#activePeak = -1;
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#container = root.querySelector<HTMLElement>("[part=chart]")!;
      this.#container.addEventListener("keydown", (event) => this.#handleKeydown(event));
      this.#title = root.querySelector<HTMLElement>("[part=title]")!;
      this.#titleSlot = root.querySelector<HTMLSlotElement>("slot[name=title]")!;
      this.#titleSlot.addEventListener("slotchange", () => {
        if (this.isConnected) this.#render();
      });
      this.#status = root.querySelector<HTMLElement>("[part=status]")!;
      this.#announcement = root.querySelector<HTMLElement>("[part=peak-announcement]")!;
    }
    // Preserve data assigned before the custom element was registered.
    if (Object.prototype.hasOwnProperty.call(this, "data")) {
      const peaks = this.data;
      Reflect.deleteProperty(this, "data");
      this.data = peaks;
      return;
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#dispose();
  }

  attributeChangedCallback(name: string): void {
    if (name === "mz-min" || name === "mz-max") this.#zoomDomain = undefined;
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  #render(): void {
    const fallbackTitle = this.getAttribute("chart-title") ?? "";
    if (this.#titleSlot.textContent !== fallbackTitle) this.#titleSlot.textContent = fallbackTitle;
    const titleNodes = this.#titleSlot.assignedNodes();
    const title = titleNodes.length
      ? titleNodes
          .map((node) => node.textContent ?? "")
          .join("")
          .trim()
      : fallbackTitle;
    this.#title.hidden = !title;

    try {
      const heightAttribute = this.getAttribute("height");
      const height = heightAttribute === null ? 360 : Number(heightAttribute);
      if (!Number.isFinite(height) || height <= 0) {
        throw new RangeError("Spectrum height must be a finite, positive number.");
      }
      const labelsAttribute = this.getAttribute("labels");
      if (labelsAttribute !== null && !["", "true", "false"].includes(labelsAttribute)) {
        throw new TypeError('Spectrum labels must be "true" or "false".');
      }
      const minimumMz = this.getAttribute("mz-min");
      const maximumMz = this.getAttribute("mz-max");
      let mzDomain: readonly [number, number] | undefined;
      if (minimumMz !== null || maximumMz !== null) {
        if (minimumMz === null || maximumMz === null || !minimumMz.trim() || !maximumMz.trim()) {
          throw new RangeError("Set both mz-min and mz-max to specify the spectrum m/z range.");
        }
        mzDomain = [Number(minimumMz), Number(maximumMz)];
      }
      const definition = createMassSpectrumChart(this.#data, {
        color: this.getAttribute("color") ?? getComputedStyle(this).color,
        textColor: getComputedStyle(this).color,
        labels: labelsAttribute !== "false",
        mzDomain,
        zoomDomain: this.#zoomDomain,
        xLabel: this.getAttribute("x-label") ?? undefined,
      });
      if (this.#data.length === 0) {
        this.#dispose();
        this.#defaultMzDomain = undefined;
        this.#status.className = "status";
        this.#status.textContent = "No peaks to display.";
        this.#status.hidden = false;
        return;
      }
      const defaultMzDomain = mzDomain ?? getAutomaticMzDomain(this.#data);
      this.#defaultMzDomain = defaultMzDomain;
      this.#container.style.height = `${height}px`;
      this.#container.setAttribute("aria-label", title || "Mass spectrum");
      const description = `${this.#data.length} peaks. Intensities normalized to the base peak at 100%. Use the mouse wheel or pinch to zoom, the area zoom tool to select an m/z section, drag or the range slider to pan, plus and minus to zoom, Home to reset, and arrow keys to inspect peaks.`;
      this.#container.setAttribute("aria-description", description);
      definition.aria = {
        enabled: true,
        label: { description: `${title || "Mass spectrum"}. ${description}` },
      };
      if (!this.#host) {
        this.#host = init(this.#container, undefined, {
          renderer: "svg",
          width: this.#container.clientWidth || 640,
          height,
        });
        this.#host.on("datazoom", () => this.#syncZoom());
        this.#resizeObserver = new ResizeObserver(() => {
          if (this.#container.clientWidth > 0) {
            this.#host?.resize({ width: this.#container.clientWidth });
          }
        });
        this.#resizeObserver.observe(this.#container);
      }
      this.#host.setOption(definition, { notMerge: true });
      this.#host.resize({ width: this.#container.clientWidth || 640, height });
      this.#syncZoom();
      this.#status.hidden = true;
    } catch (error) {
      this.#dispose();
      this.#container.replaceChildren();
      this.#defaultMzDomain = undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#status.className = "status error";
      this.#status.textContent = err.message;
      this.#status.hidden = false;
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
    }
  }

  #dispose(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#host?.dispose();
    this.#host = undefined;
    this.#announcement.textContent = "";
  }

  #syncZoom(): void {
    const zooms = this.#host?.getOption().dataZoom;
    const zoom: unknown = Array.isArray(zooms) ? zooms[0] : undefined;
    if (
      zoom &&
      typeof zoom === "object" &&
      "startValue" in zoom &&
      typeof zoom.startValue === "number" &&
      "endValue" in zoom &&
      typeof zoom.endValue === "number"
    ) {
      this.#zoomDomain = [zoom.startValue, zoom.endValue];
    }
    this.#activePeak = -1;
    this.#announcement.textContent = "";
  }

  #setZoom(domain?: readonly [number, number]): void {
    if (!domain || !this.#host) return;
    this.#host.dispatchAction({ type: "hideTip" });
    this.#host.dispatchAction({ type: "dataZoom", startValue: domain[0], endValue: domain[1] });
  }

  #handleKeydown(event: KeyboardEvent): void {
    if (!this.#host || !this.#defaultMzDomain) return;
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      this.#zoomBy(event.key === "-" ? 2 : 0.5);
    } else if (event.key === "Home") {
      this.#setZoom(this.#defaultMzDomain);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const domain = this.#zoomDomain ?? this.#defaultMzDomain;
      const visible = this.#data.flatMap((peak, index) =>
        peak.mz >= domain[0] && peak.mz <= domain[1] ? [index] : [],
      );
      if (!visible.length) return;
      const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
      const position = visible.indexOf(this.#activePeak);
      const nextPosition =
        position === -1
          ? direction === 1
            ? 0
            : visible.length - 1
          : (position + direction + visible.length) % visible.length;
      this.#activePeak = visible[nextPosition]!;
      this.#host.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: this.#activePeak });
      const peak = normalizeSpectrumPeaks(this.#data)[this.#activePeak]!;
      this.#announcement.textContent = createSpectrumTooltip(
        peak,
        this.getAttribute("x-label") ?? "m/z",
      ).getAttribute("aria-label");
    } else if (event.key === "Escape") {
      this.#host.dispatchAction({ type: "hideTip" });
      this.#announcement.textContent = "";
    } else {
      return;
    }
    event.preventDefault();
  }

  #zoomBy(factor: number): void {
    const extent = this.#defaultMzDomain;
    if (!extent) return;
    const current = this.#zoomDomain ?? extent;
    const extentSpan = extent[1] - extent[0];
    const currentSpan = current[1] - current[0];
    const nextSpan = Math.max(extentSpan / 1_000_000, Math.min(extentSpan, currentSpan * factor));
    if (nextSpan === currentSpan) return;
    const center = (current[0] + current[1]) / 2;
    let start = center - nextSpan / 2;
    let end = center + nextSpan / 2;
    if (start < extent[0]) {
      end += extent[0] - start;
      start = extent[0];
    }
    if (end > extent[1]) {
      start -= end - extent[1];
      end = extent[1];
    }
    this.#setZoom([start, end]);
  }
}

if (!customElements.get("ms-mass-spectrum")) {
  customElements.define("ms-mass-spectrum", MsMassSpectrum);
}

declare global {
  interface HTMLElementTagNameMap {
    "ms-mass-spectrum": MsMassSpectrum;
  }
}
