import type { AtomCount } from './types.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}

/** Formats an atom label as HTML, including its isotope superscript when specified. */
export function formatAtomHtml(atom: Pick<AtomCount, 'symbol' | 'mass_number' | 'isotope_was_specified'>): string {
  const isotope = atom.isotope_was_specified ? `<sup>${atom.mass_number}</sup>` : '';
  return `${isotope}${escapeHtml(atom.symbol)}`;
}

/** Formats atom counts as HTML with isotope and count superscripts/subscripts. */
export function formatFormulaHtml(atomCounts: readonly AtomCount[]): string {
  return atomCounts
    .map((atom) => {
      const subscript = atom.count === 1 ? '' : `<sub>${atom.count}</sub>`;
      return `${formatAtomHtml(atom)}${subscript}`;
    })
    .join('');
}