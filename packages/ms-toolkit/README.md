# ms-toolkit

Mass spectrometry calculators and charts for web applications. The toolkit
combines TypeScript web components with a Rust/WebAssembly calculation core.

## Components

| Component                     | Import                              | Purpose                                  |
| ----------------------------- | ----------------------------------- | ---------------------------------------- |
| `<ms-ion-calculator>`         | `ms-toolkit/ion-calculator`         | Formula mass, m/z, and unsaturation.     |
| `<ms-fine-isotope-structure>` | `ms-toolkit/fine-isotope-structure` | Fine isotope distributions.              |
| `<ms-mass-split>`             | `ms-toolkit/mass-split`             | Formula comparison and mass differences. |
| `<ms-peak-assignment>`        | `ms-toolkit/peak-assignment`        | Candidate formulas for a measured peak.  |
| `<ms-mass-spectrum>`          | `ms-toolkit/mass-spectrum`          | Interactive centroid spectra.            |
| `<ms-table>`                  | `ms-toolkit/table`                  | Sortable, paginated tables.              |

Import a component to register just that custom element. Importing
`ms-toolkit` registers all components and also exports the chart and core
helpers.

## Read ASC spectra

```ts
import { callClient } from "ms-toolkit/core";

const spectrum = await callClient((client) =>
  client.parseAsc("202.85354 917992 0.00018\n203.07609 965440 0.00014"),
);
```

`parseAsc(text)` parses ASC text using the existing Rust reader in a
WebAssembly worker, with no server upload. `callClient` also rejects worker
load/crash failures and permits a fresh worker on the next call.
Applications own file selection,
loading and error states, and presentation of the parsed spectrum.
Each nonblank line must contain exactly three whitespace-separated numbers:
**m/z, intensity, signal-to-noise**. Headers are not supported. For example:

```text
202.85354 917992 0.00018
203.07609 965440 0.00014
204.55546 1842229 0.00015
```

m/z must be finite and positive; intensity and signal-to-noise must be finite
and nonnegative. Blank lines are ignored, and peak order and duplicate m/z values
are preserved. The result is a `MassSpectrumResult` containing
`peaks: { mz, intensity, signal_to_noise }[]`, retaining original values without
normalization. Invalid rows reject with an `Error` containing line-specific
diagnostics rather than returning a partial spectrum. Empty input returns
`{ peaks: [] }`; applications decide whether to accept it.

Map each parsed peak to `{ mz: peak.mz, int: peak.intensity }` for the generic
`<ms-mass-spectrum>` element or the `createMassSpectrumChart` option builder from
`ms-toolkit/charts`.

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

The build regenerates WebAssembly bindings, builds the library and declarations,
and bundles the worker and its WebAssembly asset for package consumers.
Use `vp run wasm` to regenerate the bindings separately.
