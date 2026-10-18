# ms-toolkit

Mass spectrometry calculators and charts for web applications. The toolkit
combines TypeScript web components with a Rust/WebAssembly calculation core.

## Components

| Component                     | Import                              | Purpose                                                                                      |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `<ms-ion-calculator>`         | `ms-toolkit/ion-calculator`         | Calculate formula mass, m/z, and degree of unsaturation for a charged formula.               |
| `<ms-fine-isotope-structure>` | `ms-toolkit/fine-isotope-structure` | Calculate a formula's fine isotope distribution and display it as a spectrum and peak table. |
| `<ms-mass-split>`             | `ms-toolkit/mass-split`             | Compare two formulas and show their unmatched components and mass difference.                |
| `<ms-mass-spectrum>`          | `ms-toolkit/mass-spectrum`          | Plot supplied centroid peaks as an interactive mass spectrum.                                |
| `<ms-table>`                  | `ms-toolkit/table`                  | Display sortable, paginated data tables.                                                     |

Import a component to register just that custom element. Importing
`ms-toolkit` registers all components and also exports the chart and core
helpers.

## Quick start

```html
<ms-ion-calculator formula="C6H12O6" charge="1"></ms-ion-calculator>
<ms-fine-isotope-structure formula="C2H6O"></ms-fine-isotope-structure>
<ms-mass-split formula-a="C14H23S" formula-b="C17H19"></ms-mass-split>
```

Components with forms calculate when submitted; formula and charge attributes
can also initialize calculations. For example, use `<ms-mass-spectrum>` with
peak data from JavaScript:

```ts
import "ms-toolkit/mass-spectrum";

const spectrum = document.querySelector("ms-mass-spectrum")!;
spectrum.data = [
  { mz: 43, int: 1000 },
  { mz: 57, int: 250 },
  { mz: 71.0855, int: 500 },
];
```

The spectrum is rendered as centroid sticks, with intensities normalized to
the base peak. It supports zooming, panning, tooltips, and keyboard interaction.
Use `x-label="Mass (Da)"` when the supplied values are neutral masses; the
toolkit does not convert m/z values or apply adduct corrections.

Calculations run through a shared Web Worker backed by WebAssembly.
Calculation results are dispatched as bubbling `ms-result` events (the mass
split component uses `ms-mass-split-result`); failures are displayed and
dispatched as bubbling `ms-error` events. Isotope calculations try full
coverage first, then retry at 99.99%, 99.9%, and 99% if the 200,000-state cap
is exceeded. The displayed retained probability indicates how much probability
the returned distribution contains.

## Charts and helpers

For custom chart layouts, `ms-toolkit/charts` exports ECharts option builders.
`ms-toolkit/core` exports calculation types and utilities, including formula
formatting and intensity normalization. The `ms-toolkit/charts` entry point
does not require a browser DOM.

## Development

From `packages/ms-toolkit`:

```sh
vp dev playground --config vite.config.ts
vp test --run
vp check
vp run build
```

`vp run build` regenerates the WebAssembly bindings before building the
package. Use `vp run wasm` after Rust WebAssembly API changes; Rust checks are
available as `vp run rust-check`, `vp run rust-test`, and `vp run rust-fmt`.
For browser bundle releases, run `just release` from the repository root.
