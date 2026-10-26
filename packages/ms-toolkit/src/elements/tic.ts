import { init, use, type EChartsType } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import {
  createTicChart,
  findNearestTicPointIndex,
  ticBinCount,
  MAX_RENDERED_TIC_POINTS,
  type TicPoint,
  type TicViewportSource,
} from "../charts/tic.ts";
export type {
  TicPoint,
  TicViewportRequest,
  TicViewportResult,
  TicViewportSource,
} from "../charts/tic.ts";

use([
  LineChart,
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  MarkAreaComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  SVGRenderer,
]);

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host { display: block; min-width: 0; font: inherit; }
    .chart { min-width: 0; }
    .status { margin: 0.5rem 0; text-align: center; font-size: 0.875em; }
    .error { color: #b91c1c; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  </style>
  <div class="chart" part="chart" role="region" tabindex="0"
    aria-label="Total ion chromatogram. Click inside the plot to select the nearest displayed RT. Use left and right arrows to inspect points, Enter or Space to select, and Home to restore the RT axis."></div>
  <p class="status" part="status" role="status">No TIC source.</p>
  <p class="sr-only" role="status" aria-live="polite"></p>
`;

/**
 * `<ms-tic height="280">` displays original total ion intensity against RT.
 * Tooltip intensities use scientific notation with four significant digits.
 * Assign `viewportSource` for bounded asynchronous queries of complete scan totals.
 * Zooming queries finer samples; ties in a bin retain the earliest RT.
 * `selectedRange` highlights an applied inclusive RT range without changing the viewport.
 * Plot clicks snap to the nearest displayed RT, regardless of intensity.
 * Equidistant clicks select the earlier RT; clicks outside the plot are ignored.
 * Clicking the plot or pressing Enter/Space dispatches `ms-rt-select`
 * (detail: TicPoint); the consumer applies [retentionTime, retentionTime].
 * Query failures dispatch `ms-error` (detail: Error), retaining the previous plot.
 */
export class MsTic extends HTMLElement {
  static observedAttributes = ["height", "color"];
  #source?: TicViewportSource;
  #selectedRange?: readonly [number, number];
  #range?: readonly [number, number];
  #points: readonly TicPoint[] = [];
  #host?: EChartsType;
  #container!: HTMLElement;
  #status!: HTMLElement;
  #announcement!: HTMLElement;
  #observer?: ResizeObserver;
  #frame?: number;
  #run = 0;
  #lastQuery?: string;
  #loading = false;
  #active = -1;

  get viewportSource(): TicViewportSource | undefined {
    return this.#source;
  }
  set viewportSource(source: TicViewportSource | undefined) {
    if (source) {
      ticBinCount({ rtRange: source.rtRange, binCount: 1 });
      if (typeof source.query !== "function")
        throw new TypeError("A TIC source must provide a query function.");
    }
    this.#dispose();
    this.#source = source;
    this.#range = source ? [...source.rtRange] : undefined;
    this.#points = [];
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  get selectedRange(): readonly [number, number] | undefined {
    return this.#selectedRange;
  }
  set selectedRange(range: readonly [number, number] | undefined) {
    if (range) ticBinCount({ rtRange: range, binCount: 1 });
    this.#selectedRange = range ? [...range] : undefined;
    if (this.#host) this.#updateSeries();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#container = root.querySelector<HTMLElement>("[part=chart]")!;
      this.#status = root.querySelector<HTMLElement>("[part=status]")!;
      this.#announcement = root.querySelector<HTMLElement>(".sr-only")!;
      this.#container.addEventListener("keydown", (event) => this.#keydown(event));
    }
    if (Object.prototype.hasOwnProperty.call(this, "viewportSource")) {
      const source = this.viewportSource;
      Reflect.deleteProperty(this, "viewportSource");
      this.viewportSource = source;
    }
    if (Object.prototype.hasOwnProperty.call(this, "selectedRange")) {
      const range = this.selectedRange;
      Reflect.deleteProperty(this, "selectedRange");
      this.selectedRange = range;
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#dispose();
  }
  attributeChangedCallback(): void {
    if (this.isConnected && this.shadowRoot) this.#render();
  }

  #render(): void {
    try {
      if (!this.#source) {
        this.#status.className = "status";
        this.#status.setAttribute("part", "status");
        this.#status.textContent = "No TIC source.";
        return;
      }
      const height = this.hasAttribute("height") ? Number(this.getAttribute("height")) : 280;
      if (!Number.isFinite(height) || height <= 0)
        throw new RangeError("TIC height must be a finite, positive number.");
      this.#container.style.height = `${height}px`;
      if (!this.#host) {
        this.#range = [...this.#source.rtRange];
        this.#host = init(this.#container, undefined, {
          renderer: "svg",
          width: this.#container.clientWidth || 640,
          height,
        });
        this.#host.setOption(
          createTicChart(this.#points, this.#source.rtRange, this.#selectedRange, this.#colors()),
        );
        this.#host.getZr().on("click", (event) => {
          this.#click(event.offsetX, event.offsetY);
        });
        this.#host.on("datazoom", () => {
          const zooms = this.#host?.getOption().dataZoom;
          const zoom: unknown = Array.isArray(zooms) ? zooms[0] : undefined;
          if (
            zoom &&
            typeof zoom === "object" &&
            "startValue" in zoom &&
            "endValue" in zoom &&
            typeof zoom.startValue === "number" &&
            typeof zoom.endValue === "number" &&
            this.#source
          ) {
            this.#range = [
              Math.max(this.#source.rtRange[0], zoom.startValue),
              Math.min(this.#source.rtRange[1], zoom.endValue),
            ];
            this.#schedule();
          }
        });
        this.#host.on("restore", () => {
          this.#updateSeries();
          this.#range = this.#source?.rtRange;
          this.#lastQuery = undefined;
          this.#schedule();
        });
        this.#observer = new ResizeObserver(() => {
          if (this.#container.clientWidth > 0) {
            this.#host?.resize({ width: this.#container.clientWidth });
            this.#schedule();
          }
        });
        this.#observer.observe(this.#container);
      } else {
        this.#updateSeries();
        this.#host.resize({ width: this.#container.clientWidth || 640, height });
      }
      this.#schedule();
    } catch (error) {
      this.#error(error);
    }
  }

  #updateSeries(): void {
    if (!this.#source || !this.#host) return;
    const option = createTicChart(
      this.#points,
      this.#source.rtRange,
      this.#selectedRange,
      this.#colors(),
    );
    this.#host.setOption(
      {
        series: option.series,
        tooltip: option.tooltip,
        textStyle: option.textStyle,
        xAxis: option.xAxis,
        yAxis: option.yAxis,
      },
      { silent: true },
    );
  }

  #colors() {
    return {
      color: this.getAttribute("color") ?? undefined,
      textColor: getComputedStyle(this).color,
    };
  }

  #binCount(): number {
    return Math.max(
      1,
      Math.min(MAX_RENDERED_TIC_POINTS, Math.floor((this.#container.clientWidth || 640) - 115)),
    );
  }

  #key(): string {
    return `${this.#range?.join(",")},${this.#binCount()}`;
  }

  #schedule(): void {
    if (this.#frame !== undefined) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      if (this.#source && this.#range && this.#key() !== this.#lastQuery) void this.#load();
    });
  }

  async #load(): Promise<void> {
    if (!this.#source || !this.#range) return;
    const current = ++this.#run;
    const key = this.#key();
    const request = { rtRange: this.#range, binCount: this.#binCount() };
    this.#lastQuery = key;
    this.#loading = true;
    this.#container.setAttribute("aria-busy", "true");
    this.#status.className = "status";
    this.#status.setAttribute("part", "status");
    this.#status.textContent = "Loading TIC...";
    try {
      const result = await this.#source.query(request);
      if (current !== this.#run || !this.#host || key !== this.#key()) return;
      if (
        !Number.isSafeInteger(result.visibleCount) ||
        result.visibleCount < result.points.length ||
        result.points.length > request.binCount ||
        result.points.some(
          (point) =>
            point.retentionTime < request.rtRange[0] || point.retentionTime > request.rtRange[1],
        )
      ) {
        throw new Error(
          "The TIC query returned invalid counts or points outside its viewport budget.",
        );
      }
      const option = createTicChart(
        result.points,
        this.#source.rtRange,
        this.#selectedRange,
        this.#colors(),
      );
      this.#host.dispatchAction({ type: "hideTip" });
      this.#host.setOption({ series: option.series, tooltip: option.tooltip }, { silent: true });
      this.#points = result.points.map((point) => ({ ...point }));
      this.#active = -1;
      this.#announcement.textContent = "";
      this.#status.textContent =
        result.visibleCount === 0
          ? "No RT values in this range."
          : `Showing ${result.points.length.toLocaleString()} of ${result.visibleCount.toLocaleString()} RT values.` +
            (result.points.length < result.visibleCount
              ? " Highest scan total per horizontal bin; zoom in for finer detail."
              : "");
      this.dispatchEvent(new CustomEvent("ms-viewport-loaded", { bubbles: true }));
    } catch (error) {
      if (current === this.#run && key === this.#key()) {
        this.#lastQuery = undefined;
        this.#error(error);
      }
    } finally {
      if (current === this.#run) {
        this.#loading = false;
        this.#container.removeAttribute("aria-busy");
      }
    }
  }

  #select(index: number): void {
    if (this.#loading || !this.#points[index]) return;
    const point = this.#points[index];
    this.dispatchEvent(
      new CustomEvent<TicPoint>("ms-rt-select", { detail: { ...point }, bubbles: true }),
    );
  }

  #click(x: number, y: number): void {
    if (
      !this.#host ||
      !this.#range ||
      this.#loading ||
      this.#lastQuery !== this.#key() ||
      !this.#host.containPixel({ gridIndex: 0 }, [x, y])
    )
      return;
    try {
      const retentionTime: unknown = this.#host.convertFromPixel({ xAxisIndex: 0 }, x);
      if (typeof retentionTime !== "number" || !Number.isFinite(retentionTime)) {
        throw new Error("The TIC could not determine the clicked RT.");
      }
      const index = findNearestTicPointIndex(this.#points, retentionTime, this.#range);
      if (index < 0) return;
      this.#active = index;
      this.#select(index);
    } catch (error) {
      this.#error(error);
    }
  }

  #keydown(event: KeyboardEvent): void {
    if (!this.#host) return;
    if (event.key === "Home") {
      event.preventDefault();
      this.#host.dispatchAction({ type: "restore" });
    } else if (!this.#loading && this.#points.length) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        this.#active =
          this.#active < 0
            ? 0
            : Math.max(
                0,
                Math.min(
                  this.#points.length - 1,
                  this.#active + (event.key === "ArrowRight" ? 1 : -1),
                ),
              );
        const point = this.#points[this.#active];
        this.#announcement.textContent = `RT ${point.retentionTime}; total ion intensity ${point.intensity}. Press Enter to select this RT.`;
        this.#host.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: this.#active });
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#select(Math.max(0, this.#active));
      }
    }
  }

  #error(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.#status.className = "status error";
    this.#status.setAttribute("part", "status error");
    this.#status.textContent = `Could not display TIC: ${err.message}`;
    this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
  }

  #dispose(): void {
    ++this.#run;
    if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
    this.#frame = undefined;
    this.#lastQuery = undefined;
    this.#loading = false;
    this.#active = -1;
    this.#container?.removeAttribute("aria-busy");
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#host?.dispose();
    this.#host = undefined;
  }
}

if (!customElements.get("ms-tic")) customElements.define("ms-tic", MsTic);
