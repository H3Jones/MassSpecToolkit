# MassSpecToolkit website

Independent React + TypeScript application built with package-local Vite+ 1.2,
Tailwind CSS v4, and shadcn/ui (Radix). Uses its own npm lockfile; the toolkit
package and its development playground remain independent.

## Development

Use a Node version supported by Vite+ 1.2: 22.18+, 24.11+, or 26+.
Install Rust, the `wasm32-unknown-unknown` target (`rustup target add
wasm32-unknown-unknown`), and `wasm-pack` (`cargo install wasm-pack --locked`).
Install the toolkit dependencies with `npm ci` in `packages/ms-toolkit`, then
from this directory:

```sh
npm ci
npm run dev
npm run check
npm test
npm run build
npm run preview
```

Open the server's `/MassSpecToolkit/` URL. `npm run check` runs Vite+ formatting,
linting, and type checks; the production build also runs TypeScript. Both
`npm run dev` and `npm run build` regenerate the toolkit's WASM bindings.
`npm run wasm` runs that generation separately.

## Scope

The top-bar Spectra dropdown opens the spectrum inspector, and Toolkit lists
each calculator plus an All tools link. The landing page also links to these pages:

- `#/spectrum`: import a text peak list (.txt, .asc, .csv, .tsv) with automatic
  format detection into an in-memory DuckDB-Wasm database and inspect its spectrum,
  summary, and sortable peak table. Rust supplies full-file `SpectrumMetadata`
  (filename, measurement bounds, peak count, and `Direct`/`Hyphenated` type), also
  stored in DuckDB's `SpectrumMetadata` table. Only Hyphenated spectra show RT
  selectors and a total ion chromatogram (TIC), starting at the first RT and retaining
  original input units. Click a TIC point to select one RT slice; use numeric bounds
  for wider inclusive ranges.
  One dataset stays in memory across navigation; refreshing clears it. Failed
  imports retain the previous spectrum.
- `#/tools/ion-calculator`: formula mass, m/z, and degree of unsaturation.
- `#/tools/mass-split`: unmatched components and signed mass difference.
- `#/tools/fine-isotope-structure`: isotope distribution, spectrum, and peak table.

Each page calculates an example on opening and allows the inputs to be edited.
Instructions describe charge handling, units, and isotope coverage limits.
Loading failures and calculation errors are displayed explicitly.
The landing-page spectrum remains a labelled static illustration.

The theme initially follows the operating system. The theme button switches
between light and dark and remembers the selection in browser storage.
Fonts, icons, and styles are bundled locally, with no third-party CDN requests.

## GitHub Pages

The Vite base path is `/MassSpecToolkit/`, matching the repository's Pages URL:
`https://h3jones.github.io/MassSpecToolkit/`. `npm run build` produces the static
site in `dist`.

App navigation uses hash routes, so direct links, refresh, and browser
back/forward work on Pages without a server-side SPA rewrite. For example:
`https://h3jones.github.io/MassSpecToolkit/#/tools/ion-calculator`.
Unknown page routes display a not-found message. Home-page section anchors
continue to work.

## UI and toolkit integration

shadcn configuration lives in [components.json](./components.json); generated
UI primitives are in [src/components/ui](./src/components/ui). Add components
from this directory with `npx shadcn@latest add <component>`.

Calculator pages are lazy-loaded, keeping chart code off the initial landing
page. They reuse the existing toolkit web components, including their forms,
loading states, errors, and results; no calculations are reimplemented in React.
The spectrum page delegates ingestion and database coordination to a data worker,
reusing the toolkit's WASM reader, chart, and table. The parser worker streams UTF-8
in 64 KiB reads and transfers bounded columnar batches with insertion backpressure.
Imports report progress and can be cancelled; selecting another file also cancels
the previous import. Failed or cancelled imports retain the last valid dataset.
DuckDB's single-threaded worker and WASM
assets are bundled locally, without cross-origin isolation requirements or CDN
requests. Separate queries return selection summaries, width-bounded strongest-peak
chart samples, and database-sorted table pages of at most 100 rows. All original
measurements stay in DuckDB; RT filters do not sum or tolerance-bin spectra.
The TIC separately sums original intensities per non-null RT in DuckDB. Zoomable,
width-bounded samples retain the strongest complete scan per bin, with earliest RT
breaking ties; zooming retrieves finer detail without moving all scans to the UI.
Parsing retains an unfinished line and bounded batches, not the full input or peak
vector. The database still holds every measurement in memory; persistence is not
implemented yet.
No imported data is sent to a server.

The local `ms-toolkit` dependency is aliased to its TypeScript source in the
Vite and TypeScript configurations. This lets Vite process the worker and WASM
assets directly without relying on a prebuilt library distribution. The
toolkit marks source component registrations as side effects so production
tree-shaking preserves them. Keep both alias configurations in sync when
adding tool imports.

Inputs and submit buttons are themed through the components' `input` and
`button` CSS parts. Calculators inherit the site's light/dark color scheme.
