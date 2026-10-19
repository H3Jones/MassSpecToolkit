# MassSpecToolkit

Mass spectrometry tools built with Rust, WebAssembly, TypeScript, and Python.

## Structure

- `crates/ms-core` — Rust mass spectrometry calculations.
- `crates/ms-wasm` — WebAssembly bindings for the Rust core.
- `crates/ms-py` — [Python bindings](crates/ms-py/README.md) built with PyO3 and maturin.
- `packages/ms-toolkit` — TypeScript web components, charts, and playground.
- `apps/web` — [React website](apps/web/README.md) built with Vite+ and shadcn/ui;
  includes ion, mass split, and isotope calculators, with a
  [manual GitHub Pages deployment](.github/workflows/deploy-pages.yml)
  from the latest default-branch commit.

## Playground

A number of the components can be seen in the playground 

```sh
just run-playground
```
