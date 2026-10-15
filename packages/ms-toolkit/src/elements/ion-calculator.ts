import { formatAtomHtml, formatFormulaHtml, getClient, type IonResult } from '../core/index.ts';

const template = document.createElement('template');
template.innerHTML = `
  <style>
    :host { display: block; font: inherit; }
    form { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; }
    label { display: grid; gap: 0.25rem; font-size: 0.85em; }
    input { padding: 0.4rem; font: inherit; }
    button { padding: 0.45rem 1rem; font: inherit; }
    .error { color: #b91c1c; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { padding: 0.25rem 0.75rem; text-align: right; border-bottom: 1px solid #ddd; }
    th:first-child, td:first-child { text-align: left; }
  </style>
  <form part="form">
    <label>Formula <input name="formula" value="C6H12O6" required></label>
    <label>Charge <input name="charge" type="number" min="-255" max="255" step="1" value="1" required></label>
    <button type="submit">Calculate</button>
  </form>
  <div part="result" aria-live="polite"></div>
`;

/**
 * `<ms-ion-calculator formula="C6H12O6" charge="1">`
 * Dispatches `ms-result` (detail: IonResult) or `ms-error` (detail: Error).
 */
export class MsIonCalculator extends HTMLElement {
  static observedAttributes = ['formula', 'charge'];

  #form!: HTMLFormElement;
  #output!: HTMLElement;
  #run = 0;

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: 'open' });
      root.append(template.content.cloneNode(true));
      this.#form = root.querySelector('form')!;
      this.#output = root.querySelector('[part=result]')!;
      this.#form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.calculate();
      });
    }
    this.#syncInputs();
    if (this.hasAttribute('formula')) void this.calculate();
  }

  attributeChangedCallback(): void {
    if (!this.isConnected || !this.shadowRoot) return;
    this.#syncInputs();
    void this.calculate();
  }

  #inputs(): { formula: HTMLInputElement; charge: HTMLInputElement } {
    return this.#form.elements as unknown as { formula: HTMLInputElement; charge: HTMLInputElement };
  }

  #syncInputs(): void {
    const { formula, charge } = this.#inputs();
    const attrFormula = this.getAttribute('formula');
    const attrCharge = this.getAttribute('charge');
    if (attrFormula !== null) formula.value = attrFormula;
    if (attrCharge !== null) charge.value = attrCharge;
  }

  async calculate(): Promise<IonResult | undefined> {
    const { formula, charge } = this.#inputs();
    const run = ++this.#run;
    try {
      const result = await getClient().evaluateIon(formula.value, charge.valueAsNumber);
      if (run !== this.#run) return undefined;
      this.#render(result);
      this.dispatchEvent(new CustomEvent('ms-result', { detail: result, bubbles: true }));
      return result;
    } catch (error) {
      if (run !== this.#run) return undefined;
      const err = error instanceof Error ? error : new Error(String(error));
      this.#output.replaceChildren(
        Object.assign(document.createElement('p'), { className: 'error', textContent: err.message }),
      );
      this.dispatchEvent(new CustomEvent('ms-error', { detail: err, bubbles: true }));
      return undefined;
    }
  }

  #render(result: IonResult): void {
    const summary = document.createElement('p');
    const formula = document.createElement('span');
    formula.innerHTML = formatFormulaHtml(result.atom_counts);
    const massToCharge =
      result.mass_to_charge === null ? '' : `, m/z ${result.mass_to_charge.toFixed(6)}`;
    summary.append(
      formula,
      document.createTextNode(`: mass ${result.mass.toFixed(6)}${massToCharge}`),
    );

    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Atom</th><th>Count</th><th>RAM</th><th>Total Mass</th></tr></thead>';
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

if (!customElements.get('ms-ion-calculator')) {
  customElements.define('ms-ion-calculator', MsIonCalculator);
}
