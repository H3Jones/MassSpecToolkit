# ms-toolkit

Mass spectrometry calculators and charts for web applications. The toolkit
combines TypeScript web components with a Rust/WebAssembly calculation core.

## Components

| Component | Import | Purpose |
| --- | --- | --- |
| `<ms-ion-calculator>` | `ms-toolkit/ion-calculator` | Formula mass, m/z, and unsaturation. |
| `<ms-fine-isotope-structure>` | `ms-toolkit/fine-isotope-structure` | Fine isotope distributions. |
| `<ms-mass-split>` | `ms-toolkit/mass-split` | Formula comparison and mass differences. |
| `<ms-peak-assignment>` | `ms-toolkit/peak-assignment` | Candidate formulas for a measured peak. |
| `<ms-mass-spectrum>` | `ms-toolkit/mass-spectrum` | Interactive centroid spectra. |
| `<ms-table>` | `ms-toolkit/table` | Sortable, paginated tables. |

Import a component to register just that custom element. Importing
`ms-toolkit` registers all components and also exports the chart and core
helpers.

## Quick start

```ts
import "ms-toolkit/ion-calculator";
```

```html
<ms-ion-calculator formula="C6H12O6" charge="1"></ms-ion-calculator>
```

For custom interfaces, `ms-toolkit/charts` provides ECharts option builders and
`ms-toolkit/core` provides calculation types and utilities.

## Development

From `packages/ms-toolkit`:

```sh
vp dev playground --config vite.config.ts
vp test --run
vp check
vp run build
```

The build regenerates WebAssembly bindings. Use `vp run wasm` to regenerate
them separately.
