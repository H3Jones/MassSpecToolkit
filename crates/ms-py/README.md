# ms-py

Python bindings for `ms-core`, built with PyO3 and maturin. The distribution is
named `ms-py`; import it as `ms_py`. Requires Python 3.10+ and a Rust toolchain
supporting edition 2024 to build from source. Wheels use CPython's stable ABI.

## Development

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then run
from this directory:

```sh
uv sync
uv run python -m unittest discover -s tests -v
```

`uv sync` creates `.venv` and builds an editable installation using maturin.
No environment activation or Python runtime dependencies are required.

Rebuild the extension after Rust changes:

```sh
uv sync --reinstall-package ms-py
```

Build a release wheel or source distribution:

```sh
uv run --with "maturin>=1.9,<2" maturin build --release
uv run --with "maturin>=1.9,<2" maturin sdist
```

Artifacts are written to the workspace's `target/wheels` directory. Install a
wheel with `uv pip install <wheel-path>` into an existing virtual environment
(create one with `uv venv` if needed). Type hints ship with the wheel.

From the repository root, run `cargo check --workspace`,
`cargo test --workspace`, and `cargo fmt --all -- --check` for Rust validation.

## Example scripts

Run the scripts in [examples](examples) from this directory after `uv sync`.
Both accept a formula argument and print the result as formatted JSON:

```sh
uv run python examples/parse_formula.py "C6H12O6"
uv run python examples/parse_formula.py "^13CH4"
uv run python examples/isotope_distribution.py "H2O"
uv run python examples/isotope_distribution.py "H2O" --charge 1 --coverage 1
uv run python examples/isotope_distribution.py "C10H20O5" --coverage 0.999 --max-states 100000
```

Use `--help` to see arguments. Invalid formulas or failed calculations print an
error to stderr and exit with a nonzero status. Neutral mass-to-charge values
appear as `null`.

## API

```python
import ms_py

water = ms_py.parse_formula("H2O")
print(water.formula, water.mass, water.dbe)
print([(atom.symbol, atom.count) for atom in water.atom_counts])

ion = ms_py.evaluate_ion("H2O", charge=1)
print(ion.mass_to_charge)

split = ms_py.mass_split("C2H6O", "CH4")
print(split.formula_a_only.formula)  # CH2O
print(split.mass_difference)  # signed: formula_a - formula_b

distribution = ms_py.fine_isotope_distribution(
    "H2O", charge=1, coverage=0.9999, max_states=200_000
)
for peak in distribution.peaks:
    print(peak.label, peak.mass, peak.mass_to_charge, peak.abundance)
```

- `parse_formula(input)` returns a `FormulaResult` with the core's `formula` string,
  monoisotopic `mass`, `dbe`, and `atom_counts`. Explicit isotopes use the core
  syntax, e.g. `^13CH4`. Element order is preserved, not converted to Hill order.
- Each `AtomCount` has `symbol`, `mass_number`, `isotope_was_specified`,
  `atom_ram`, `count`, and `total_mass`.
- `evaluate_ion(input, charge=0)` returns an `IonResult` with the formula
  fields plus `charge` and `mass_to_charge`. Charges range from -255 to 255.
  Mass includes electron-mass correction; neutral mass-to-charge is `None`.
  Charge does not add or remove atoms (e.g. it does not add a proton).
- `mass_split(formula_a, formula_b)` returns a `MassSplitResult` with both
  parsed formulas, `formula_a_only`, `formula_b_only`, and signed
  `mass_difference`. Empty components are `None`.
- `fine_isotope_distribution(input, charge=0, *, coverage=0.9999,
  max_states=200_000)` returns a `FineIsotopeDistributionResult` with `charge`,
  `retained_probability`, and mass-sorted `peaks`. Each `FineIsotopePeakResult`
  has `label`, electron-corrected `mass`, `mass_to_charge` (`None` for neutral),
  and absolute `abundance`. Abundances are not renormalized after pruning.
  Coverage must be finite and in `(0, 1]`; `1` requests exhaustive expansion.
  The expensive distribution calculation releases the GIL.

Results have read-only attributes. Collection getters return fresh lists;
changing those lists does not change the underlying result.
`ELECTRON_MASS` (in atomic mass units) and `__version__` are also exported.

Invalid formulas, unsupported charges, invalid distribution options, and missing
natural-abundance data raise `ValueError`. Exhausted state limits raise
`RuntimeError` with the best probability coverage retained at the failing
calculation step; numerical distribution failures also raise `RuntimeError`.
Wrong argument types raise `TypeError`; integers outside the binding's native
range raise `OverflowError`.
Unlike the browser binding, this API never retries with lower coverage:
increase `max_states` or explicitly reduce `coverage` when a calculation
exceeds the state limit.
