# MassSpecToolkit website

Independent React + TypeScript application built with package-local Vite+ 1.2,
Tailwind CSS v4, and shadcn/ui (Radix). Uses its own npm lockfile; the toolkit
package and its development playground remain independent.

## Development

Use a Node version supported by Vite+ 1.2: 22.18+, 24.11+, or 26+.
From this directory:

```sh
npm ci
npm run dev
npm run check
npm run build
npm run preview
```

Open the server's `/MassSpecToolkit/` URL. `npm run check` runs Vite+ formatting,
linting, and type checks; the production build also runs TypeScript.

## Scope

This first version is a landing page only. The spectrum is a labelled static
illustration, not a calculator. Tool cards describe existing library features
and explicitly mark dedicated tool pages as planned. Documentation and source
links lead to the public repository.

The theme initially follows the operating system. The theme button switches
between light and dark and remembers the selection in browser storage.
Fonts, icons, and styles are bundled locally, with no third-party CDN requests.

## GitHub Pages

The Vite base path is `/MassSpecToolkit/`, matching the repository's Pages URL:
`https://h3jones.github.io/MassSpecToolkit/`. `npm run build` produces the static
site in `dist`. No deployment workflow is included, and nothing is published
automatically. Change `base` in [vite.config.ts](./vite.config.ts) if using a
custom domain or a different repository name.

Navigation currently uses in-page anchors, so it needs no SPA rewrite or
server-side routing. Choose a Pages-compatible routing strategy before adding
dedicated tool URLs.

## UI and future tools

shadcn configuration lives in [components.json](./components.json); generated
UI primitives are in [src/components/ui](./src/components/ui). Add components
from this directory with `npx shadcn@latest add <component>`.

The toolkit is intentionally not imported yet, avoiding shipping charts or
WASM on a landing-only page. When adding calculator pages, reuse its existing
web components rather than rewriting the science in React. Verify production
custom-element registration and worker/WASM asset loading before deployment;
the toolkit's source imports currently need production side-effect handling.
