import type { AtomCount } from "./types.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

/** Formats an atom label as HTML, including its isotope superscript when specified. */
export function formatAtomHtml(
  atom: Pick<AtomCount, "symbol" | "mass_number" | "isotope_was_specified">,
): string {
  const isotope = atom.isotope_was_specified ? `<sup>${atom.mass_number}</sup>` : "";
  return `${isotope}${escapeHtml(atom.symbol)}`;
}

/** Formats whitespace-separated isotope labels such as `12C2 1H6 16O`. */
export function formatIsotopeLabelHtml(label: string): string {
  if (!label.trim()) return "";
  return label
    .trim()
    .split(/\s+/)
    .map((token) => {
      const match = /^([1-9]\d*)([A-Z][a-z]?)([1-9]\d*)?$/.exec(token);
      if (!match) throw new TypeError(`Invalid isotope label token: ${token}`);
      const massNumber = Number(match[1]);
      const count = match[3] === undefined ? 1 : Number(match[3]);
      if (!Number.isSafeInteger(massNumber) || !Number.isSafeInteger(count)) {
        throw new RangeError(`Isotope mass number and count must be safe integers: ${token}`);
      }
      const atom = formatAtomHtml({
        symbol: match[2]!,
        mass_number: massNumber,
        isotope_was_specified: true,
      });
      return count === 1 ? atom : `${atom}<sub>${count}</sub>`;
    })
    .join("");
}

/** Formats atom counts as HTML with isotope and count superscripts/subscripts. */
export function formatFormulaHtml(atomCounts: readonly AtomCount[]): string {
  return atomCounts
    .map((atom) => {
      const subscript = atom.count === 1 ? "" : `<sub>${atom.count}</sub>`;
      return `${formatAtomHtml(atom)}${subscript}`;
    })
    .join("");
}

export function renormalizeIntensities<T extends { int: number }>(
  peaks: readonly T[],
): (Omit<T, "int"> & { int: number })[] {
  const basePeakIntensity = Math.max(...peaks.map((peak) => peak.int));
  if (!Number.isFinite(basePeakIntensity) || basePeakIntensity <= 0) {
    throw new RangeError("Peaks must include a positive intensity.");
  }
  return peaks.map((peak) => ({
    ...peak,
    int: (peak.int / basePeakIntensity) * 100,
  }));
}
