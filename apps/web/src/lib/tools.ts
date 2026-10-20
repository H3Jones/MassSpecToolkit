import { FlaskConical, GitCompareArrows, ScanSearch, Waves } from "lucide-react";

export const tools = [
  {
    id: "ion-calculator",
    number: "01",
    icon: FlaskConical,
    name: "Ion calculator",
    description: "Calculate formula mass, mass-to-charge ratio (m/z), and degree of unsaturation",
    example: "C6H12O6",
    detail: "Mass and m/z",
    tag: "ms-ion-calculator",
    attributes: { formula: "C6H12O6", charge: "1" },
    notes: [
      "Enter the complete molecular composition and an integer charge from -255 to +255. Use charge 0 for a neutral formula; m/z is then not applicable.",
      "Charged masses include electron-mass correction. Charge does not add or remove protons or other adducts: include any additional atoms in the formula.",
      "Results include mass in Da, m/z for nonzero charge, degree of unsaturation (DBE), and an atom-by-atom mass breakdown.",
    ],
  },
  {
    id: "mass-split",
    number: "02",
    icon: GitCompareArrows,
    name: "Mass split",
    description: "Compare two molecular formulas and report the mass difference.",
    example: "C14H23S vs C17H19",
    detail: "Formula comparison",
    tag: "ms-mass-split",
    attributes: { "formula-a": "C14H23S", "formula-b": "C17H19" },
    notes: [
      "Enter formulas A and B to compare their compositions.",
      "The reported difference is mass(A) minus mass(B), in Da and mDa. A positive value means formula A has the greater mass.",
      "The A-only and B-only results show unmatched formula components. Equal compositions have no unmatched components and a zero mass difference.",
    ],
  },
  {
    id: "fine-isotope-structure",
    number: "03",
    icon: Waves,
    name: "Fine isotope structure",
    description: "Calculate fine isotope distributions and display calculated peak patterns.",
    example: "C2H6O",
    detail: "Isotope distributions",
    tag: "ms-fine-isotope-structure",
    attributes: { formula: "C2H6O" },
    notes: [
      "Enter a molecular formula. Leave charge blank, or use 0, for a neutral distribution plotted against mass in Da. A nonzero charge plots m/z with electron-mass correction.",
      "Peak intensities are normalized to the most abundant peak (100%). The table lists isotope assignments and supports sorting and pagination; the spectrum supports zooming and panning.",
      "Calculations first attempt full probability coverage. If the 200,000-state limit is exceeded, coverage is retried at 99.99%, 99.9%, and 99%. The result reports retained probability; sufficiently large distributions may still exceed the limit.",
    ],
  },
  {
    id: "peak-assignment",
    number: "04",
    icon: ScanSearch,
    name: "Peak assignment",
    description: "Search element and charge ranges to assign formulas to a measured mass.",
    example: "180.06284 m/z ± 5 ppm",
    detail: "Formula assignment",
    tag: "ms-peak-assignment",
    attributes: {
      mass: "180.06284",
      error: "5",
      "error-unit": "ppm",
      "charge-min": "1",
      "charge-max": "1",
      "element-ranges": "C4-100 H8-100 O2-100",
    },
    notes: [
      "Enter the observed m/z, its allowed mass error, and an inclusive signed charge range. Zero charge is excluded, and the mass is interpreted as observed m/z.",
      "Define inclusive element-count ranges; a single count such as Na1 fixes that count. Only listed elements and isotopes are searched, and unlabelled ranges use each element's most-abundant isotope.",
      "All matches are returned without chemical filtering. Wide ranges can take substantial time and memory.",
    ],
  },
] as const;

export type Tool = (typeof tools)[number];

export function toolHref(tool: Tool): string {
  return `#/tools/${tool.id}`;
}
