import { FlaskConical, GitCompareArrows, Waves } from "lucide-react";

export const tools = [
  {
    id: "ion-calculator",
    number: "01",
    icon: FlaskConical,
    name: "Ion calculator",
    description:
      "Calculate formula mass, mass-to-charge ratio (m/z), and degree of unsaturation",
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
] as const;

export type Tool = (typeof tools)[number];

export function toolHref(tool: Tool): string {
  return `#/tools/${tool.id}`;
}
