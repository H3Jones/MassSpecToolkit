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

The landing page links to three working calculators:

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

Calculator navigation uses hash routes, so direct links, refresh, and browser
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

The local `ms-toolkit` dependency is aliased to its TypeScript source in the
Vite and TypeScript configurations. This lets Vite process the worker and WASM
assets directly without relying on a prebuilt library distribution. The
toolkit marks source component registrations as side effects so production
tree-shaking preserves them. Keep both alias configurations in sync when
adding tool imports.

Inputs and submit buttons are themed through the components' `input` and
`button` CSS parts. Calculators inherit the site's light/dark color scheme.
