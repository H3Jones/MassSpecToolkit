import "../src/index.ts";
import type { MsMassSpectrum } from "../src/elements/mass-spectrum.ts";
import type { MsTable, MsTableColumn } from "../src/elements/table.ts";
import { formatIsotopeLabelHtml } from "../src/core/utils.ts";
// Preprocessed from crates/ms-core/src/isotopes/snapshots/ms_core__isotopes__distribution__tests__exhaustive_fine_structure_C2H6O.snap.
import isotopePeaks from "./ethanol-isotope-spectrum.json";

type IsotopePeak = { label: string; mz: number; int: number };

const spectrum = document.querySelector<MsMassSpectrum>("#centroid-spectrum")!;
spectrum.data = [
  { mz: 27, int: 120 },
  { mz: 29, int: 240 },
  { mz: 39, int: 180 },
  { mz: 41, int: 350 },
  { mz: 43, int: 1000 },
  { mz: 55, int: 280 },
  { mz: 57, int: 620 },
  { mz: 71, int: 440 },
  { mz: 85, int: 160 },
  { mz: 100, int: 90 },
];

// Populate the isotope spectrum with preprocessed ethanol isotope peaks.
const isotopeSpectrum = document.querySelector<MsMassSpectrum>("#isotope-spectrum")!;
isotopeSpectrum.data = isotopePeaks.map((peak) => ({
  ...peak,
  labelHtml: formatIsotopeLabelHtml(peak.label),
}));

const isotopeTable = document.querySelector<MsTable<IsotopePeak>>("#isotope-table")!;
isotopeTable.columns = [
  { accessorKey: "label", header: "Isotope assignment" },
  { accessorKey: "mz", header: "Mass (Da)", cell: ({ getValue }) => Number(getValue()).toFixed(6) },
  {
    accessorKey: "int",
    header: "Relative intensity",
    cell: ({ getValue }) => `${(Number(getValue()) * 100).toPrecision(4)}%`,
  },
] satisfies MsTableColumn<IsotopePeak>[];
isotopeTable.data = isotopePeaks;
