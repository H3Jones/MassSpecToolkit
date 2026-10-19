import { formatFormulaHtml, getClient, type MassSplitResult } from "../core/index.ts";
import commonUiStyles from "./common-ui.css?inline";

const template = document.createElement("template");
template.innerHTML = `
  <style>
    ${commonUiStyles}
    form { gap: 0.5rem; }
    label { font-size: 0.85em; }
    .result { display: grid; gap: 0.25rem; margin-top: 1rem; }
  </style>
  <form part="form">
    <label for="formula-a">Formula A</label>
    <input part="input" id="formula-a" name="formulaA" value="C14H23S" required>
    <label for="formula-b">Formula B</label>
    <input part="input" id="formula-b" name="formulaB" value="C17H19" required>
    <button part="button" type="submit">Calculate difference</button>
  </form>
  <p class="status" part="status" role="status" aria-live="polite" hidden>
    <span class="spinner" aria-hidden="true"></span> Calculating formula difference...
  </p>
  <div class="result" part="result" aria-live="polite"></div>
`;

/**
 * `<ms-mass-split formula-a="C14H23S" formula-b="C17H19">`
 * Dispatches `ms-mass-split-result` (detail: MassSplitResult) or `ms-error` (detail: Error).
 */
export class MsMassSplit extends HTMLElement {
  static observedAttributes = ["formula-a", "formula-b"];

  #form!: HTMLFormElement;
  #formulaA!: HTMLInputElement;
  #formulaB!: HTMLInputElement;
  #status!: HTMLElement;
  #submitButton!: HTMLButtonElement;
  #output!: HTMLElement;
  #run = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.append(template.content.cloneNode(true));
      this.#form = root.querySelector("form")!;
      this.#formulaA = root.querySelector<HTMLInputElement>("#formula-a")!;
      this.#formulaB = root.querySelector<HTMLInputElement>("#formula-b")!;
      this.#status = root.querySelector("[part=status]")!;
      this.#submitButton = this.#form.querySelector('button[type="submit"]')!;
      this.#output = root.querySelector<HTMLElement>("[part=result]")!;
      this.#form.addEventListener("submit", (event) => {
        event.preventDefault();
        void this.calculate();
      });
    }
    this.#syncInputs();
    if (this.hasAttribute("formula-a") && this.hasAttribute("formula-b")) {
      void this.calculate();
    }
  }

  attributeChangedCallback(): void {
    if (!this.isConnected || !this.shadowRoot) return;
    this.#syncInputs();
    if (this.#formulaA.value && this.#formulaB.value) void this.calculate();
  }

  #syncInputs(): void {
    const formulaA = this.getAttribute("formula-a");
    const formulaB = this.getAttribute("formula-b");
    if (formulaA !== null) this.#formulaA.value = formulaA;
    if (formulaB !== null) this.#formulaB.value = formulaB;
  }

  async calculate(): Promise<MassSplitResult | undefined> {
    const run = ++this.#run;
    this.#setCalculating(true);
    try {
      const result = await getClient().massSplit(this.#formulaA.value, this.#formulaB.value);
      if (run !== this.#run) return undefined;
      this.#render(result);
      this.dispatchEvent(
        new CustomEvent("ms-mass-split-result", { detail: result, bubbles: true }),
      );
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

  #render(result: MassSplitResult): void {
    const makeComponent = (label: string, formula: MassSplitResult["formula_a_only"]) => {
      const row = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = `${label}: `;
      const value = document.createElement("span");
      if (formula === null) {
        value.textContent = "—";
      } else {
        value.innerHTML = formatFormulaHtml(formula.atom_counts);
      }
      row.append(name, value);
      return row;
    };

    const massDifference = document.createElement("div");
    const sign = result.mass_difference > 0 ? "+" : "";
    const milliDaltons = (result.mass_difference * 1000).toFixed(3);
    massDifference.textContent = `Mass difference (A − B): ${sign}${result.mass_difference.toFixed(6)} Da (${sign}${milliDaltons} mDa)`;

    this.#output.replaceChildren(
      makeComponent("A only", result.formula_a_only),
      makeComponent("B only", result.formula_b_only),
      massDifference,
    );
  }
}

if (!customElements.get("ms-mass-split")) {
  customElements.define("ms-mass-split", MsMassSplit);
}
