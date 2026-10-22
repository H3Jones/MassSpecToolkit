# Vite+ project guidance

- This repository already uses Vite+ in `packages/ms-toolkit`; do not scaffold or migrate it as part of routine work. Use the package-local `vite-plus` dependency and npm lockfile.
- From `packages/ms-toolkit`, use `vp dev playground --config vite.config.ts` for the playground, `vp test --run` for tests, and `vp check` for format/lint/type checks.
- Use `vp run build` for the library build; it regenerates wasm bindings and runs `vp pack` with declarations. Use `vp run wasm` after Rust wasm API changes. Rust checks are `vp run rust-check`, `vp run rust-test`, and `vp run rust-fmt`. `vp dev` is the built-in server; use `vp run <task>` for package scripts and named tasks.
- Check published imports and declarations with `npm pack --dry-run`.
- Preserve the existing npm lockfile, Vite+ configuration, aliases, test coverage, and package behavior. Do not install a global CLI or change toolchain versions unless requested.
- For an explicitly requested Vite+ upgrade or migration, inspect the worktree and current setup first; follow the current [upgrade](https://viteplus.dev/guide/upgrade) or [migration](https://viteplus.dev/guide/migrate) guidance. Keep migration compatibility settings through a passing baseline, review manual findings, and remove settings only one at a time with affected tests and package-consumer checks passing. Do not weaken assertions or coverage.

## Documentation

When editing README files, follow the [documentation notes](../.agents/notes.md).
