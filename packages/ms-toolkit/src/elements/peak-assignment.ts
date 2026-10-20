import {
  formatAtomHtml,
  formatIonFormulaHtml,
  getClient,
  type ElementRangeResult,
  type PeakAssignmentMatchResult,
  type PeakAssignmentResult,
} from "../core/index.ts";
import type { MsTable, MsTableColumn } from "./table.ts";
import "./table.ts";
import commonUiStyles from "./common-ui.css?inline";

type RangeRow = Pick<ElementRangeResult, keyof ElementRangeResult>;
type AssignmentRow = Pick<PeakAssignmentMatchResult, keyof PeakAssignmentMatchResult>;

const template = document.createElement("template");
template.innerHTML = `
  <style>
    ${commonUiStyles}
    :host { min-width: 0; }
    form { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 0.75rem; }
    label { font-size: 0.9em; min-width: 0; }
    input, select, textarea { width: 100%; min-width: 0; color: inherit; }
    select, textarea { box-sizing: border-box; padding: 0.4rem; font: inherit; }
    select { height: 2.25rem; }
    textarea { min-height: 4.5rem; resize: vertical; }
    .full-width { grid-column: 1 / -1; }
    .help, .summary { margin: 0; color: #64748b; font-size: 0.875em; line-height: 1.5; }
    section { display: grid; gap: 0.75rem; margin-top: 1.25rem; }
    h3 { margin: 0; font-size: 1em; }
    ms-table { display: block; max-width: 100%; overflow-x: auto; }
    .error { margin: 0.75rem 0; }
    [hidden] { display: none !important; }
  </style>
  <form part="form">
    <label>Mass (m/z)
      <input part="input" name="mass" type="number" min="0" step="any" value="180.06284" required>
    </label>
    <label>Mass error (+/-)
      <input part="input" name="error" type="number" min="0" step="any" value="5" required>
    </label>
    <label>Error unit
      <select part="input" name="errorUnit">
        <option value="ppm">ppm</option>
        <option value="da">Da (m/z)</option>
      </select>
    </label>
    <label>Minimum charge
      <input part="input" name="chargeMin" type="number" min="-255" max="255" step="1" value="1" required aria-describedby="charge-help">
    </label>
    <label>Maximum charge
      <input part="input" name="chargeMax" type="number" min="-255" max="255" step="1" value="1" required aria-describedby="charge-help">
    </label>
    <p class="help full-width" id="charge-help">
      Every integer charge in the inclusive range is searched, excluding zero.
      Mass is interpreted as observed m/z. Formulas describe complete ions; no adducts are added.
      PPM errors and tolerances are relative to theoretical m/z.
    </p>
    <label class="full-width">Element ranges
      <textarea part="input" name="elementRanges" required aria-describedby="range-help">C4-100 H8-100 O2-100</textarea>
    </label>
    <p class="help full-width" id="range-help">
      Separate ranges with commas, spaces, or newlines, for example C4-100, H8-100, O2-100.
      Bounds are inclusive; a single count such as Na1 fixes both bounds to 1.
      Use a zero minimum for optional elements. Explicit isotopes are supported, for example ^13C0-1 or ^13C1.
      Counts are independent: C4-100 plus ^13C0-1 means 4-100 default carbon atoms and 0-1 carbon-13 atoms.
      Only listed isotopes are searched; unlabelled ranges use the most-abundant isotope.
      All matches are returned without chemical filtering. Wide ranges can take substantial time and memory.
    </p>
    <button part="button" type="submit">Assign peak</button>
  </form>
  <section aria-labelledby="ranges-heading" part="ranges">
    <h3 id="ranges-heading">Parsed element ranges</h3>
    <p class="status" part="range-status" role="status" aria-live="polite" hidden>
      <span class="spinner" aria-hidden="true"></span> Parsing element ranges...
    </p>
    <p class="error" part="range-error" role="alert" hidden></p>
    <ms-table id="range-table" page-size="10" aria-label="Parsed element ranges" hidden></ms-table>
  </section>
  <p class="status" part="status" role="status" aria-live="polite" hidden>
    <span class="spinner" aria-hidden="true"></span> Assigning peak...
  </p>
  <p class="error" part="error" role="alert" hidden></p>
  <section part="result" aria-labelledby="results-heading" hidden>
    <h3 id="results-heading">Peak assignments</h3>
    <p class="summary" part="summary" aria-live="polite"></p>
    <ms-table id="result-table" page-size="10" aria-label="Peak assignment results"></ms-table>
  </section>
`;

function formatError(value: unknown): string {
  const error = Number(value);
  return `${error > 0 ? "+" : ""}${error.toPrecision(6)}`;
}

/**
 * `<ms-peak-assignment mass="180.06284" error="5" error-unit="ppm"
 *   charge-min="1" charge-max="1" element-ranges="C4-100 H8-100 O2-100">`
 * Zero is excluded from the inclusive signed charge range.
 * Dispatches `ms-result` (PeakAssignmentResult), `ms-ranges-parsed`
 * (ElementRangeResult[]), or `ms-error` (Error), all bubbling.
 */
export class MsPeakAssignment extends HTMLElement {
  static observedAttributes = [
    "mass",
    "error",
    "error-unit",
    "charge-min",
    "charge-max",
    "element-ranges",
  ];

  #form!: HTMLFormElement;
  #mass!: HTMLInputElement;
  #errorInput!: HTMLInputElement;
  #unit!: HTMLSelectElement;
  #chargeMin!: HTMLInputElement;
  #chargeMax!: HTMLInputElement;
  #ranges!: HTMLTextAreaElement;
  #status!: HTMLElement;
  #submitButton!: HTMLButtonElement;
  #error!: HTMLElement;
  #rangeStatus!: HTMLElement;
  #rangeError!: HTMLElement;
  #rangeTable!: MsTable<RangeRow>;
  #output!: HTMLElement;
  #summary!: HTMLElement;
  #resultTable!: MsTable<AssignmentRow>;
  #run = 0;
  #rangeRun = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#form = root.querySelector("form")!;
      this.#mass = root.querySelector<HTMLInputElement>('[name="mass"]')!;
      this.#errorInput = root.querySelector<HTMLInputElement>('[name="error"]')!;
      this.#unit = root.querySelector<HTMLSelectElement>('[name="errorUnit"]')!;
      this.#chargeMin = root.querySelector<HTMLInputElement>('[name="chargeMin"]')!;
      this.#chargeMax = root.querySelector<HTMLInputElement>('[name="chargeMax"]')!;
      this.#ranges = root.querySelector<HTMLTextAreaElement>('[name="elementRanges"]')!;
      this.#status = root.querySelector<HTMLElement>("[part=status]")!;
      this.#submitButton = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      this.#error = root.querySelector<HTMLElement>("[part=error]")!;
      this.#rangeStatus = root.querySelector<HTMLElement>("[part=range-status]")!;
      this.#rangeError = root.querySelector<HTMLElement>("[part=range-error]")!;
      this.#rangeTable = root.querySelector<MsTable<RangeRow>>("#range-table")!;
      this.#output = root.querySelector<HTMLElement>("[part=result]")!;
      this.#summary = root.querySelector<HTMLElement>("[part=summary]")!;
      this.#resultTable = root.querySelector<MsTable<AssignmentRow>>("#result-table")!;
      this.#configureTables();
      this.#form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.calculate();
      });
      this.#form.addEventListener("input", (event) => {
        this.#invalidateResult();
        if (event.target === this.#ranges) void this.parseRanges();
      });
    }
    this.#syncInputs();
    void this.parseRanges();
    if (this.hasAttribute("mass")) void this.calculate();
  }

  disconnectedCallback(): void {
    ++this.#run;
    ++this.#rangeRun;
    this.#setCalculating(false);
  }

  attributeChangedCallback(): void {
    if (!this.isConnected || !this.shadowRoot) return;
    this.#syncInputs();
    this.#invalidateResult();
    void this.parseRanges();
    if (this.hasAttribute("mass")) void this.calculate();
  }

  #syncInputs(): void {
    const inputs = [
      ["mass", this.#mass],
      ["error", this.#errorInput],
      ["error-unit", this.#unit],
      ["charge-min", this.#chargeMin],
      ["charge-max", this.#chargeMax],
      ["element-ranges", this.#ranges],
    ] as const;
    for (const [name, input] of inputs) {
      const value = this.getAttribute(name);
      if (value !== null) input.value = value;
    }
  }

  async parseRanges(): Promise<ElementRangeResult[] | undefined> {
    const run = ++this.#rangeRun;
    this.#rangeTable.hidden = true;
    this.#rangeTable.data = [];
    this.#rangeError.hidden = true;
    this.#rangeStatus.hidden = false;
    try {
      const ranges = await getClient().parseElementRanges(this.#ranges.value);
      if (run !== this.#rangeRun) return undefined;
      this.#renderRanges(ranges);
      this.dispatchEvent(new CustomEvent("ms-ranges-parsed", { detail: ranges, bubbles: true }));
      return ranges;
    } catch (error) {
      if (run !== this.#rangeRun) return undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#rangeError.textContent = err.message;
      this.#rangeError.hidden = false;
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
      return undefined;
    } finally {
      if (run === this.#rangeRun) this.#rangeStatus.hidden = true;
    }
  }

  async calculate(): Promise<PeakAssignmentResult | undefined> {
    const run = ++this.#run;
    this.#setCalculating(true);
    this.#error.hidden = true;
    this.#output.hidden = true;
    this.#resultTable.data = [];
    try {
      const mass = this.#mass.valueAsNumber;
      const error = this.#errorInput.valueAsNumber;
      const unit = this.#unit.value;
      const chargeMin = this.#chargeMin.valueAsNumber;
      const chargeMax = this.#chargeMax.valueAsNumber;
      if (!Number.isFinite(mass) || mass <= 0) {
        throw new RangeError("Mass (m/z) must be finite and greater than zero.");
      }
      if (!Number.isFinite(error) || error < 0) {
        throw new RangeError("Mass error must be finite and nonnegative.");
      }
      if (unit !== "ppm" && unit !== "da") {
        throw new RangeError("Error unit must be ppm or da.");
      }
      if (
        !Number.isInteger(chargeMin) ||
        !Number.isInteger(chargeMax) ||
        chargeMin < -255 ||
        chargeMax > 255 ||
        chargeMin > chargeMax ||
        (chargeMin === 0 && chargeMax === 0)
      ) {
        throw new RangeError(
          "Charge bounds must be ordered integers between -255 and 255 and include a nonzero charge.",
        );
      }
      const result = await getClient().assignPeak(
        mass,
        error,
        unit,
        chargeMin,
        chargeMax,
        this.#ranges.value,
      );
      if (run !== this.#run) return undefined;
      ++this.#rangeRun;
      this.#rangeStatus.hidden = true;
      this.#rangeError.hidden = true;
      this.#renderRanges(result.element_ranges);
      this.#resultTable.data = result.matches;
      const chargeCount = result.charges.length;
      const count = result.matches.length;
      this.#summary.textContent = `${count === 0 ? "No formulas matched" : `${count} matching formula${count === 1 ? "" : "s"}`} across ${chargeCount} nonzero charge${chargeCount === 1 ? "" : "s"}. Errors are experimental minus theoretical m/z; ppm errors and tolerances are relative to theoretical m/z. Initial result order is absolute error.`;
      this.#output.hidden = false;
      this.dispatchEvent(new CustomEvent("ms-result", { detail: result, bubbles: true }));
      return result;
    } catch (error) {
      if (run !== this.#run) return undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#error.textContent = err.message;
      this.#error.hidden = false;
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
      return undefined;
    } finally {
      if (run === this.#run) this.#setCalculating(false);
    }
  }

  #invalidateResult(): void {
    ++this.#run;
    this.#setCalculating(false);
    this.#output.hidden = true;
    this.#resultTable.data = [];
    this.#error.hidden = true;
  }

  #setCalculating(calculating: boolean): void {
    this.#status.hidden = !calculating;
    this.#submitButton.disabled = calculating;
  }

  #renderRanges(ranges: ElementRangeResult[]): void {
    this.#rangeTable.data = ranges;
    this.#rangeTable.hidden = false;
  }

  #configureTables(): void {
    this.#rangeTable.columns = [
      {
        id: "atom",
        accessorFn: (range) =>
          `${range.isotope_was_specified ? `^${range.mass_number}` : ""}${range.symbol}`,
        header: "Element / isotope",
        cell: ({ row }) => {
          const atom = document.createElement("span");
          atom.innerHTML = formatAtomHtml(row.original);
          return atom;
        },
      },
      { accessorKey: "min", header: "Minimum count" },
      { accessorKey: "max", header: "Maximum count" },
    ] satisfies MsTableColumn<RangeRow>[];
    this.#resultTable.columns = [
      {
        accessorKey: "formula",
        header: "Ion formula",
        cell: ({ getValue }) => {
          const formula = document.createElement("span");
          formula.innerHTML = formatIonFormulaHtml(String(getValue()));
          return formula;
        },
      },
      {
        accessorKey: "charge",
        header: "Charge",
        cell: ({ getValue }) => {
          const charge = Number(getValue());
          return `${charge > 0 ? "+" : ""}${charge}`;
        },
      },
      {
        accessorKey: "mass",
        header: "Ion mass (Da)",
        cell: ({ getValue }) => Number(getValue()).toFixed(6),
      },
      {
        accessorKey: "mass_to_charge",
        header: "Calculated m/z",
        cell: ({ getValue }) => Number(getValue()).toFixed(6),
      },
      {
        accessorKey: "error_da",
        header: "Error (m/z)",
        cell: ({ getValue }) => formatError(getValue()),
      },
      {
        accessorKey: "error_ppm",
        header: "Error (ppm)",
        cell: ({ getValue }) => formatError(getValue()),
      },
    ] satisfies MsTableColumn<AssignmentRow>[];
  }
}

if (!customElements.get("ms-peak-assignment")) {
  customElements.define("ms-peak-assignment", MsPeakAssignment);
}

declare global {
  interface HTMLElementTagNameMap {
    "ms-peak-assignment": MsPeakAssignment;
  }
}
