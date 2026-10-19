import { formatAtomHtml, formatFormulaHtml, getClient, type IonResult } from "../core/index.ts";
import commonUiStyles from "./common-ui.css?inline";

const template = document.createElement("template");
template.innerHTML = `
  <style>
    ${commonUiStyles}
    form { gap: 0.5rem; }
    label { font-size: 0.85em; }
    .summary { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.5rem; margin: 1rem 0 0; }
    .summary dt { font-weight: 600; }
    .summary dd { margin: 0; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.25rem 0.75rem; text-align: right; border-bottom: 1px solid #ddd; }
    th:first-child, td:first-child { text-align: left; }
  </style>
  <form part="form">
    <label>Formula <input part="input" name="formula" value="C6H12O6" required></label>
    <label>Charge <input part="input" name="charge" type="number" min="-255" max="255" step="1" value="1" required></label>
    <button part="button" type="submit">Calculate</button>
  </form>
  <p class="status" part="status" role="status" aria-live="polite" hidden>
    <span class="spinner" aria-hidden="true"></span> Calculating ion...
  </p>
  <div part="result" aria-live="polite"></div>
`;

/**
 * `<ms-ion-calculator formula="C6H12O6" charge="1">`
 * Dispatches `ms-result` (detail: IonResult) or `ms-error` (detail: Error).
 */
export class MsIonCalculator extends HTMLElement {
  static observedAttributes = ["formula", "charge"];

  #form!: HTMLFormElement;
  #status!: HTMLElement;
  #submitButton!: HTMLButtonElement;
  #output!: HTMLElement;
  #run = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#form = root.querySelector("form")!;
      this.#status = root.querySelector("[part=status]")!;
      this.#submitButton = this.#form.querySelector('button[type="submit"]')!;
      this.#output = root.querySelector("[part=result]")!;
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
    void this.calculate();
  }

  #inputs(): { formula: HTMLInputElement; charge: HTMLInputElement } {
    return this.#form.elements as unknown as {
      formula: HTMLInputElement;
      charge: HTMLInputElement;
    };
  }

  #syncInputs(): void {
    const { formula, charge } = this.#inputs();
    const attrFormula = this.getAttribute("formula");
    const attrCharge = this.getAttribute("charge");
    if (attrFormula !== null) formula.value = attrFormula;
    if (attrCharge !== null) charge.value = attrCharge;
  }

  async calculate(): Promise<IonResult | undefined> {
    const { formula, charge } = this.#inputs();
    const run = ++this.#run;
    this.#setCalculating(true);
    try {
      const result = await getClient().evaluateIon(formula.value, charge.valueAsNumber);
      if (run !== this.#run) return undefined;
      this.#render(result);
      this.dispatchEvent(new CustomEvent("ms-result", { detail: result, bubbles: true }));
      return result;
    } catch (error) {
      if (run !== this.#run) return undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      const message = Object.assign(document.createElement("p"), {
        className: "error",
        role: "alert",
        textContent: err.message,
      });
      message.part.add("error");
      this.#output.replaceChildren(message);
      this.dispatchEvent(new CustomEvent("ms-error", { detail: err, bubbles: true }));
      return undefined;
    } finally {
      if (run === this.#run) this.#setCalculating(false);
    }
  }

  #setCalculating(calculating: boolean): void {
    this.#status.hidden = !calculating;
    this.#submitButton.disabled = calculating;
  }

  #render(result: IonResult): void {
    const summary = document.createElement("dl");
    summary.className = "summary";
    const formula = document.createElement("span");
    formula.innerHTML = formatFormulaHtml(result.atom_counts);
    const addSummaryRow = (label: string, value: Node | string): void => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      if (typeof value === "string") description.textContent = value;
      else description.append(value);
      summary.append(term, description);
    };

    addSummaryRow("Parsed Formula:", formula);
    addSummaryRow("Mass:", result.mass.toFixed(6));
    addSummaryRow("m/z:", result.mass_to_charge?.toFixed(6) ?? "N/A");
    addSummaryRow("DBE:", String(result.dbe));

    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th>Atom</th><th>Count</th><th>RAM</th><th>Total Mass</th></tr></thead>";
    const body = table.createTBody();
    for (const atom of result.atom_counts) {
      const row = body.insertRow();
      row.insertCell().innerHTML = formatAtomHtml(atom);
      row.insertCell().textContent = String(atom.count);
      row.insertCell().textContent = atom.atom_ram.toFixed(6);
      row.insertCell().textContent = atom.total_mass.toFixed(6);
    }
    this.#output.replaceChildren(summary, table);
  }
}

if (!customElements.get("ms-ion-calculator")) {
  customElements.define("ms-ion-calculator", MsIonCalculator);
}
