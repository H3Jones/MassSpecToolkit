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
  copySpectrumPeaks,
  normalizeSpectrumPeaks,
  type RelativeSpectrumPeak,
  type SpectrumPeak,
  type SpectrumIntensityMode,
} from "../charts/index.ts";
import {
  createPreparedMassSpectrumChart,
  createSpectrumViewportUpdate,
  createSpectrumTooltipFormatter,
  getAutomaticMzDomain,
  getSpectrumIntensityMode,
  MAX_RENDERED_SPECTRUM_PEAKS,
  selectSpectrumPeaks,
  type SpectrumPeakSelection,
} from "../charts/mass-spectrum.ts";
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
    .status { margin: 0.5rem 0; text-align: center; }
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

export interface SpectrumViewportRequest {
  readonly mzRange: readonly [number, number];
  readonly binCount: number;
}

/** Return one strongest peak per requested bin, in source order; ties retain the first row. */
export interface SpectrumViewportSource {
  readonly peakCount: number;
  readonly maximumMz: number;
  readonly minimumIntensity: number;
  readonly maximumIntensity: number;
  query(request: SpectrumViewportRequest): Promise<{
    readonly peaks: readonly SpectrumPeak[];
    readonly visibleCount: number;
  }>;
}

/**
 * `<ms-mass-spectrum chart-title="Mass spectrum" height="360">`
 * Assign centroid peaks to `data`. The default intensity-mode="relative" uses a
 * 100% base peak; intensity-mode="absolute" displays original intensity values.
 * Only the strongest visible peaks are rendered; the full dataset is retained.
 * Rendering errors dispatch `ms-error` (detail: Error).
 * Set `viewportSource` instead of `data` for bounded asynchronous viewport queries.
 * Successful remote queries dispatch `ms-viewport-loaded`; stale results are ignored.
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
    "intensity-mode",
  ];

  #data: readonly RelativeSpectrumPeak[] = [];
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
  #selection: SpectrumPeakSelection = { indices: [], visibleCount: 0 };
  #intensityMode: SpectrumIntensityMode = "relative";
  #chartTitle = "";
  #pendingRender?: {
    startedAt: number;
    phase: "initial" | "update" | "viewport";
    peakCount: number;
    visiblePeakCount: number;
    renderedPeakCount: number;
    preparationMs?: number;
  };
  #selectionFrame?: number;
  #viewportSource?: SpectrumViewportSource;
  #viewportRun = 0;
  #viewportLoading = false;
  #lastViewport?: string;

  get viewportSource(): SpectrumViewportSource | undefined {
    return this.#viewportSource;
  }

  set viewportSource(source: SpectrumViewportSource | undefined) {
    if (
      source &&
      (!Number.isSafeInteger(source.peakCount) ||
        source.peakCount < 0 ||
        !Number.isFinite(source.maximumMz) ||
        source.maximumMz < 0 ||
        !Number.isFinite(source.minimumIntensity) ||
        source.minimumIntensity < 0 ||
        !Number.isFinite(source.maximumIntensity) ||
        source.maximumIntensity < source.minimumIntensity ||
        typeof source.query !== "function")
    ) {
      throw new TypeError(
        "A spectrum viewport source must provide finite bounds, a peak count, and a query function.",
      );
    }
    ++this.#viewportRun;
    this.#viewportSource = source;
    this.#lastViewport = undefined;
    this.#data = [];
    this.#selection = { indices: [], visibleCount: 0 };
    this.#zoomDomain = undefined;
    this.#activePeak = -1;
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  get data(): readonly SpectrumPeak[] {
    return copySpectrumPeaks(this.#data);
  }

  /** Invalid data throws before replacing the current spectrum. */
  set data(peaks: readonly SpectrumPeak[]) {
    this.#data = normalizeSpectrumPeaks(peaks);
    ++this.#viewportRun;
    this.#viewportSource = undefined;
    this.#lastViewport = undefined;
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
    const ownData = Object.prototype.hasOwnProperty.call(this, "data");
    const ownSource = Object.prototype.hasOwnProperty.call(this, "viewportSource");
    const peaks = ownData ? this.data : undefined;
    const source = ownSource ? this.viewportSource : undefined;
    if (ownData) {
      Reflect.deleteProperty(this, "data");
    }
    if (ownSource) Reflect.deleteProperty(this, "viewportSource");
    if (peaks !== undefined) this.data = peaks;
    if (ownSource) this.viewportSource = source;
    if (!ownData && !ownSource) this.#render();
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
    this.#chartTitle = title || "Mass spectrum";

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
      const intensityMode = getSpectrumIntensityMode(
        this.getAttribute("intensity-mode") ?? undefined,
      );
      const preparationStartedAt = performance.now();
      const source = this.#viewportSource;
      mzDomain ??= source ? getAutomaticMzDomain([{ mz: source.maximumMz, int: 0 }]) : undefined;
      const prepared = createPreparedMassSpectrumChart(
        this.#data,
        {
          color: this.getAttribute("color") ?? getComputedStyle(this).color,
          textColor: getComputedStyle(this).color,
          intensityMode,
          labels: labelsAttribute !== "false",
          mzDomain,
          zoomDomain: this.#zoomDomain,
          xLabel: this.getAttribute("x-label") ?? undefined,
          intensityExtent: source ? [source.minimumIntensity, source.maximumIntensity] : undefined,
        },
        source ? this.#selection : undefined,
      );
      const preparationMs = Math.round((performance.now() - preparationStartedAt) * 100) / 100;
      const definition = prepared.option;
      this.#selection = prepared.selection;
      this.#intensityMode = intensityMode;
      if (this.#data.length === 0 && !source?.peakCount) {
        this.#updatePresentation();
        this.#dispose();
        this.#defaultMzDomain = undefined;
        this.#status.className = "status";
        this.#status.textContent = "No peaks to display.";
        this.#status.hidden = false;
        return;
      }
      this.#defaultMzDomain = prepared.mzDomain;
      this.#container.style.height = `${height}px`;
      definition.aria = this.#updatePresentation();
      const initialRender = !this.#host;
      const renderStartedAt = performance.now();
      if (!this.#host) {
        this.#host = init(this.#container, undefined, {
          renderer: "svg",
          width: this.#container.clientWidth || 640,
          height,
        });
        this.#host.on("finished", () => this.#logRenderCompletion());
        this.#host.on("datazoom", () => this.#syncZoom());
        this.#host.on("restore", () => {
          this.#lastViewport = undefined;
          this.#setZoom(this.#defaultMzDomain);
        });
        this.#resizeObserver = new ResizeObserver(() => {
          if (this.#container.clientWidth > 0) {
            this.#host?.resize({ width: this.#container.clientWidth });
            this.#scheduleSelectionUpdate();
          }
        });
        this.#resizeObserver.observe(this.#container);
      }
      this.#pendingRender = {
        startedAt: renderStartedAt,
        phase: initialRender ? "initial" : "update",
        peakCount: source?.peakCount ?? this.#data.length,
        visiblePeakCount: prepared.selection.visibleCount,
        renderedPeakCount: prepared.selection.indices.length,
        preparationMs,
      };
      this.#host.setOption(definition, { notMerge: true });
      this.#host.resize({ width: this.#container.clientWidth || 640, height });
      this.#syncZoom();
    } catch (error) {
      this.#showError(error);
    }
  }

  #logRenderCompletion(): void {
    const pendingRender = this.#pendingRender;
    if (!pendingRender) return;
    this.#pendingRender = undefined;
    const { startedAt, ...details } = pendingRender;
    console.debug("[ms-toolkit] Spectrum chart render complete", {
      ...details,
      renderMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }

  #updatePresentation() {
    const { indices, visibleCount } = this.#selection;
    const showing = `Showing ${indices.length.toLocaleString()} of ${visibleCount.toLocaleString()} peaks in the current m/z range.`;
    const reduced = indices.length < visibleCount;
    const intensityDescription =
      this.#intensityMode === "absolute"
        ? "Absolute intensities in the original input units."
        : "Intensities normalized to the dataset's base peak at 100%.";
    const description = `${this.#viewportSource?.peakCount ?? this.#data.length} peaks. ${showing} ${intensityDescription} Use the mouse wheel or pinch to zoom the m/z axis, Shift+wheel or the vertical range slider to zoom intensity, the area zoom tool to select an m/z and intensity section, drag or the m/z range slider to pan, plus and minus to zoom m/z, Home or the restore control to reset both axes, and arrow keys to inspect displayed peaks.`;
    const label = `${this.#chartTitle}. ${description}`;
    this.#container.setAttribute("aria-label", label);
    this.#container.setAttribute("aria-description", description);
    this.#status.className = "status";
    this.#status.textContent = reduced
      ? `${showing} Only the strongest peak in each horizontal plot bin is drawn; zoom in to separate nearby peaks.`
      : visibleCount === 0
        ? "No peaks in this m/z range."
        : showing;
    this.#status.hidden = !reduced && visibleCount > 0;
    return { enabled: true, label: { description: label } };
  }

  #showError(error: unknown): void {
    this.#dispose();
    this.#container.replaceChildren();
    this.#defaultMzDomain = undefined;
    const err = error instanceof Error ? error : new Error(String(error));
    this.#status.className = "status error";
    this.#status.textContent = err.message;
    this.#status.hidden = false;
    this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
  }

  #dispose(): void {
    ++this.#viewportRun;
    this.#lastViewport = undefined;
    this.#viewportLoading = false;
    this.#container.removeAttribute("aria-busy");
    if (this.#selectionFrame !== undefined) cancelAnimationFrame(this.#selectionFrame);
    this.#selectionFrame = undefined;
    this.#pendingRender = undefined;
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
    this.#scheduleSelectionUpdate();
  }

  #scheduleSelectionUpdate(): void {
    if (this.#selectionFrame === undefined && this.#zoomDomain && this.#host) {
      this.#selectionFrame = requestAnimationFrame(() => {
        this.#selectionFrame = undefined;
        try {
          this.#updateSelection();
        } catch (error) {
          this.#showError(error);
        }
      });
    }
  }

  #updateSelection(): void {
    if (!this.#host || !this.#zoomDomain) return;
    const binCount = this.#binCount();
    if (this.#viewportSource) {
      const key = `${this.#zoomDomain[0]},${this.#zoomDomain[1]},${binCount}`;
      if (key !== this.#lastViewport) {
        this.#lastViewport = key;
        void this.#loadViewport(this.#viewportSource, this.#zoomDomain, binCount);
      }
      return;
    }
    const selection = selectSpectrumPeaks(this.#data, this.#zoomDomain, binCount);
    this.#applySelection(selection);
  }

  #binCount(): number {
    if (!this.#host || !this.#zoomDomain) return MAX_RENDERED_SPECTRUM_PEAKS;
    const startPixel = this.#host.convertToPixel({ xAxisIndex: 0 }, this.#zoomDomain[0]);
    const endPixel = this.#host.convertToPixel({ xAxisIndex: 0 }, this.#zoomDomain[1]);
    const pixelWidth = Math.abs(endPixel - startPixel);
    return Number.isFinite(pixelWidth)
      ? Math.max(1, Math.min(MAX_RENDERED_SPECTRUM_PEAKS, Math.floor(pixelWidth)))
      : MAX_RENDERED_SPECTRUM_PEAKS;
  }

  async #loadViewport(
    source: SpectrumViewportSource,
    domain: readonly [number, number],
    binCount: number,
  ) {
    const current = ++this.#viewportRun;
    this.#viewportLoading = true;
    this.#container.setAttribute("aria-busy", "true");
    this.#status.className = "status";
    this.#status.textContent = "Loading spectrum viewport...";
    this.#status.hidden = false;
    try {
      const result = await source.query({ mzRange: domain, binCount });
      if (
        current !== this.#viewportRun ||
        !this.#host ||
        domain[0] !== this.#zoomDomain?.[0] ||
        domain[1] !== this.#zoomDomain?.[1] ||
        binCount !== this.#binCount()
      )
        return;
      if (
        !Number.isSafeInteger(result.visibleCount) ||
        result.visibleCount < result.peaks.length ||
        result.visibleCount > source.peakCount ||
        result.peaks.length > binCount
      ) {
        throw new Error(
          "The spectrum viewport query returned invalid counts or exceeded its bin budget.",
        );
      }
      const data = normalizeSpectrumPeaks(result.peaks, source.maximumIntensity);
      const occupied = new Set<number>();
      for (const peak of data) {
        const bin = Math.min(
          binCount - 1,
          Math.floor(((peak.mz - domain[0]) / (domain[1] - domain[0])) * binCount),
        );
        if (
          peak.mz < domain[0] ||
          peak.mz > domain[1] ||
          peak.int < source.minimumIntensity ||
          occupied.has(bin)
        ) {
          throw new Error(
            "Spectrum viewport peaks must be within the requested range, with at most one per bin.",
          );
        }
        occupied.add(bin);
      }
      this.#data = data;
      this.#applySelection(
        { indices: data.map((_, index) => index), visibleCount: result.visibleCount },
        true,
      );
      this.dispatchEvent(new CustomEvent("ms-viewport-loaded", { bubbles: true }));
    } catch (error) {
      if (current !== this.#viewportRun) return;
      this.#lastViewport = undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#status.className = "status error";
      this.#status.textContent = `Could not load this spectrum viewport: ${err.message}`;
      this.#status.hidden = false;
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
    } finally {
      if (current === this.#viewportRun) {
        this.#viewportLoading = false;
        this.#container.removeAttribute("aria-busy");
      }
    }
  }

  #applySelection(selection: SpectrumPeakSelection, replaceData = false): void {
    if (!this.#host || !this.#zoomDomain) return;
    const sameIndices =
      selection.indices.length === this.#selection.indices.length &&
      selection.indices.every((index, position) => index === this.#selection.indices[position]);
    if (!replaceData && sameIndices && selection.visibleCount === this.#selection.visibleCount)
      return;
    this.#selection = selection;
    this.#activePeak = -1;
    this.#announcement.textContent = "";
    this.#host.dispatchAction({ type: "hideTip" });
    const renderStartedAt = performance.now();
    this.#pendingRender = {
      startedAt: renderStartedAt,
      phase: "viewport",
      peakCount: this.#viewportSource?.peakCount ?? this.#data.length,
      visiblePeakCount: selection.visibleCount,
      renderedPeakCount: selection.indices.length,
    };
    this.#host.setOption(
      {
        ...createSpectrumViewportUpdate(
          this.#data,
          selection.indices,
          this.#intensityMode,
          this.#zoomDomain,
        ),
        aria: this.#updatePresentation(),
        tooltip: {
          formatter: createSpectrumTooltipFormatter(
            this.#data,
            this.getAttribute("x-label") ?? "m/z",
            this.#intensityMode,
          ),
        },
      },
      { silent: true },
    );
  }

  #setZoom(domain?: readonly [number, number]): void {
    if (!domain || !this.#host) return;
    this.#host.dispatchAction({ type: "hideTip" });
    this.#host.dispatchAction({
      type: "dataZoom",
      dataZoomId: "mz-inside",
      startValue: domain[0],
      endValue: domain[1],
    });
  }

  #resetZoom(): void {
    if (!this.#defaultMzDomain || !this.#host) return;
    this.#host.dispatchAction({ type: "hideTip" });
    this.#host.dispatchAction({ type: "restore" });
  }

  #handleKeydown(event: KeyboardEvent): void {
    if (!this.#host || !this.#defaultMzDomain) return;
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      this.#zoomBy(event.key === "-" ? 2 : 0.5);
    } else if (event.key === "Home") {
      this.#resetZoom();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      if (this.#selectionFrame !== undefined) {
        cancelAnimationFrame(this.#selectionFrame);
        this.#selectionFrame = undefined;
        try {
          this.#updateSelection();
        } catch (error) {
          this.#showError(error);
          return;
        }
      }
      const visible = this.#selection.indices;
      if (this.#viewportSource && this.#viewportLoading) {
        event.preventDefault();
        return;
      }
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
      this.#host.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: nextPosition });
      const peak = this.#data[this.#activePeak]!;
      this.#announcement.textContent = createSpectrumTooltip(
        peak,
        this.getAttribute("x-label") ?? "m/z",
        getSpectrumIntensityMode(this.getAttribute("intensity-mode") ?? undefined),
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
