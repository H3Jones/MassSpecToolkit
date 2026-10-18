# MassSpecToolkit

Mass spectrometry tools built with Rust, WebAssembly, TypeScript, and Python.

## Structure

- `crates/ms-core` — Rust mass spectrometry calculations.
- `crates/ms-wasm` — WebAssembly bindings for the Rust core.
- `crates/ms-py` — [Python bindings](crates/ms-py/README.md) built with PyO3 and maturin.
- `packages/ms-toolkit` — TypeScript web components, charts, and playground.

## Playground

A number of the components can be seen in the playground 

```sh
just run-playground
```
