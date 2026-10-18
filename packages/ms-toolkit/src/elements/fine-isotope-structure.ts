import {
  formatIsotopeLabelHtml,
  getClient,
  renormalizeIntensities,
  type FineIsotopeDistributionResult,
} from "../core/index.ts";
import type { MsMassSpectrum } from "./mass-spectrum.ts";
import type { MsTable, MsTableColumn } from "./table.ts";
import "./mass-spectrum.ts";
import "./table.ts";
import commonUiStyles from "./common-ui.css?inline";

type DisplayPeak = { label: string; mass: number; mz: number | null; int: number };

const template = document.createElement("template");
template.innerHTML = `
  <style>
    ${commonUiStyles}
    :host { min-width: 0; }
    form { gap: 0.75rem; margin-bottom: 1rem; }
    label { font-size: 0.9em; }
    input { width: 100%; min-width: 8rem; }
    .output { display: grid; gap: 1rem; }
    .summary { margin: 0; color: #64748b; font-size: 0.9em; }
    ms-mass-spectrum { display: block; min-height: 360px; }
    ms-table { display: block; max-width: 100%; overflow-x: auto; }
    .error { margin: 0; }
    [hidden] { display: none !important; }
  </style>
  <form part="form">
    <label>Formula <input name="formula" value="C2H6O" required></label>
    <label>Charge (optional)
      <input name="charge" type="number" min="-255" max="255" step="1" value="" inputmode="numeric">
    </label>
    <button type="submit">Calculate distribution</button>
  </form>
  <p class="error" part="error" role="alert" hidden></p>
  <div class="output" part="output" hidden>
    <p class="summary" part="summary" aria-live="polite"></p>
    <ms-mass-spectrum labels="false" color="#2563eb"></ms-mass-spectrum>
    <ms-table page-size="10" aria-label="Fine isotope peaks"></ms-table>
  </div>
`;

/**
 * `<ms-fine-isotope-structure formula="C2H6O" charge="1">`
 * An omitted or empty charge calculates the neutral distribution.
 * Dispatches `ms-result` (detail: FineIsotopeDistributionResult) or `ms-error` (detail: Error).
 */
export class MsFineIsotopeStructure extends HTMLElement {
  static observedAttributes = ["formula", "charge"];

  #form!: HTMLFormElement;
  #formula!: HTMLInputElement;
  #charge!: HTMLInputElement;
  #error!: HTMLElement;
  #output!: HTMLElement;
  #summary!: HTMLElement;
  #spectrum!: MsMassSpectrum;
  #table!: MsTable<DisplayPeak>;
  #run = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#form = root.querySelector("form")!;
      this.#formula = this.#form.elements.namedItem("formula") as HTMLInputElement;
      this.#charge = this.#form.elements.namedItem("charge") as HTMLInputElement;
      this.#error = root.querySelector("[part=error]")!;
      this.#output = root.querySelector("[part=output]")!;
      this.#summary = root.querySelector("[part=summary]")!;
      this.#spectrum = root.querySelector("ms-mass-spectrum")!;
      this.#table = root.querySelector("ms-table")!;
      this.#form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.calculate();
      });
    }
    this.#syncInputs();
    if (this.hasAttribute("formula")) void this.calculate();
  }

  attributeChangedCallback(): void {
    if (!this.isConnected || !this.shadowRoot) return;
    this.#syncInputs();
    if (this.#formula.value.trim()) void this.calculate();
  }

  #syncInputs(): void {
    const formula = this.getAttribute("formula");
    const charge = this.getAttribute("charge");
    if (formula !== null) this.#formula.value = formula;
    this.#charge.value = charge ?? "";
  }

  async calculate(): Promise<FineIsotopeDistributionResult | undefined> {
    const run = ++this.#run;
    const charge = this.#charge.value.trim() === "" ? 0 : this.#charge.valueAsNumber;
    try {
      if (!Number.isInteger(charge) || charge < -255 || charge > 255) {
        throw new RangeError("Charge must be an integer between -255 and 255.");
      }
      const result = await getClient().fineIsotopeDistribution(this.#formula.value, charge);
      if (run !== this.#run) return undefined;
      this.#render(result);
      this.dispatchEvent(new CustomEvent("ms-result", { detail: result, bubbles: true }));
      return result;
    } catch (error) {
      if (run !== this.#run) return undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#error.textContent = err.message;
      this.#error.hidden = false;
      this.#output.hidden = true;
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
      return undefined;
    }
  }

  #render(result: FineIsotopeDistributionResult): void {
    const isIon = result.charge !== 0;
    const peaks: DisplayPeak[] = result.peaks.map((peak) => ({
      label: peak.label,
      mass: peak.mass,
      mz: peak.mass_to_charge,
      int: peak.abundance,
    }));
    const chartPeaks = peaks.map((peak) => ({
      mz: peak.mz ?? peak.mass,
      int: peak.int,
      labelHtml: formatIsotopeLabelHtml(peak.label),
    }));
    const tablePeaks: DisplayPeak[] = renormalizeIntensities(
      peaks.map((peak) => ({ ...peak, mz: peak.mz ?? peak.mass })),
    );
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const peak of chartPeaks) {
      minimum = Math.min(minimum, peak.mz);
      maximum = Math.max(maximum, peak.mz);
    }
    const padding = Math.max((maximum - minimum) * 0.05, Math.abs(maximum) * 0.005);
    this.#spectrum.setAttribute("x-label", isIon ? "m/z" : "Mass (Da)");
    this.#spectrum.setAttribute("mz-min", String(Math.max(0, minimum - padding)));
    this.#spectrum.setAttribute("mz-max", String(maximum + padding));
    this.#spectrum.data = chartPeaks;
    this.#table.setAttribute("aria-label", isIon ? "Fine isotope m/z peaks" : "Fine isotope peaks");
    this.#table.columns = [
      {
        accessorKey: "label",
        header: "Isotope assignment",
        cell: ({ getValue }) => {
          const assignment = document.createElement("span");
          assignment.innerHTML = formatIsotopeLabelHtml(String(getValue()));
          return assignment;
        },
      },
      {
        accessorKey: "mz",
        header: isIon ? "m/z" : "Mass (Da)",
        cell: ({ getValue }) => Number(getValue()).toFixed(6),
      },
      {
        accessorKey: "int",
        header: "Relative intensity (%)",
        cell: ({ getValue }) => `${Number(getValue()).toPrecision(4)}%`,
      },
    ] satisfies MsTableColumn<DisplayPeak>[];
    this.#table.data = tablePeaks;
    this.#summary.textContent = `${result.peaks.length} peaks · ${(result.retained_probability * 100).toFixed(4)}% probability retained${isIon ? ` · charge ${result.charge > 0 ? "+" : ""}${result.charge}` : " · neutral"}`;
    this.#error.hidden = true;
    this.#output.hidden = false;
  }
}

if (!customElements.get("ms-fine-isotope-structure")) {
  customElements.define("ms-fine-isotope-structure", MsFineIsotopeStructure);
}
