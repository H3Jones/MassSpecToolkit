import DOMPurify from "dompurify";
import type { RelativeSpectrumPeak, SpectrumIntensityMode } from "./mass-spectrum.ts";

export function createSpectrumTooltip(
  peak: RelativeSpectrumPeak,
  xLabel: string,
  intensityMode: SpectrumIntensityMode = "relative",
): HTMLElement {
  const card = document.createElement("div");
  card.style.cssText = "display:grid;gap:0.3rem;font:500 0.75rem/1.3 system-ui,sans-serif";
  const assignment = document.createElement("div");
  assignment.className = "ms-spectrum-assignment";
  if (peak.labelHtml !== undefined) {
    assignment.append(
      DOMPurify.sanitize(peak.labelHtml, {
        ALLOWED_TAGS: ["sup", "sub", "b", "i", "em", "strong", "span", "br"],
        ALLOWED_ATTR: [],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
        RETURN_DOM_FRAGMENT: true,
      }),
    );
  } else if (peak.label !== undefined) {
    assignment.textContent = peak.label;
  }
  const accessibleText: string[] = [];
  if (assignment.hasChildNodes()) {
    card.append(assignment);
    accessibleText.push(peak.label ?? assignment.textContent ?? "");
  }
  const intensity = peak.relativeIntensity;
  for (const text of [
    `${xLabel}: ${peak.mz}`,
    intensityMode === "absolute"
      ? `Absolute intensity: ${peak.int}`
      : `Relative intensity: ${intensity > 0 && intensity < 0.01 ? intensity.toExponential(2) : intensity.toFixed(2)}%`,
  ]) {
    const line = document.createElement("div");
    line.textContent = text;
    card.append(line);
    accessibleText.push(text);
  }
  card.setAttribute("role", "tooltip");
  card.setAttribute("aria-label", accessibleText.join("\n"));
  return card;
}
