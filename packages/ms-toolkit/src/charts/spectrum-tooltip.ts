import DOMPurify from "dompurify";
import type { ChartTooltipExtension } from "@tanstack/charts";
import { tooltip } from "@tanstack/charts/tooltip";

/** Uses the standard tooltip lifecycle and positioning with a safe formula-aware body. */
export const spectrumTooltip: ChartTooltipExtension = {
  ...tooltip,
  id: "mass-spectrum-tooltip",
  create(context) {
    let body: HTMLElement | undefined;
    let accessibleName = "";
    const renderBody: NonNullable<ReturnType<typeof context.bodyChange>> = (target) => {
      if (!target) {
        body = undefined;
        return;
      }
      const { element, content } = target;
      body = element;
      const document = element.ownerDocument;
      const card = document.createElement("div");
      const accessibleText: string[] = [];
      card.style.cssText = `
        display:grid;gap:0.3rem;padding:0.4rem 0.55rem;
        border:var(--ts-chart-tooltip-border, 1px solid color-mix(in srgb, CanvasText 18%, transparent));
        border-radius:var(--ts-chart-tooltip-border-radius, 0.45rem);
        background:var(--ts-chart-tooltip-background, Canvas);
        color:var(--ts-chart-tooltip-color, CanvasText);
        box-shadow:var(--ts-chart-tooltip-shadow, 0 6px 24px rgb(0 0 0 / 0.14));
        font:var(--ts-chart-tooltip-font, 500 0.75rem/1.3 system-ui, sans-serif);
      `;
      const datum = target.primaryPoint?.datum;
      if (datum && typeof datum === "object") {
        const assignment = document.createElement("div");
        assignment.className = "ms-spectrum-assignment";
        if ("labelHtml" in datum && typeof datum.labelHtml === "string") {
          assignment.append(
            DOMPurify.sanitize(datum.labelHtml, {
              ALLOWED_TAGS: ["sup", "sub", "b", "i", "em", "strong", "span", "br"],
              ALLOWED_ATTR: [],
              ALLOW_DATA_ATTR: false,
              ALLOW_ARIA_ATTR: false,
              RETURN_DOM_FRAGMENT: true,
            }),
          );
        } else if ("label" in datum && typeof datum.label === "string") {
          assignment.textContent = datum.label;
        }
        if (assignment.hasChildNodes()) {
          card.append(assignment);
          accessibleText.push(
            "label" in datum && typeof datum.label === "string"
              ? datum.label
              : (assignment.textContent ?? ""),
          );
        }
      }
      if (typeof content === "string") {
        card.append(content);
        accessibleText.push(content);
      } else {
        if (content.title) {
          const title = document.createElement("strong");
          title.textContent = content.title;
          card.append(title);
          accessibleText.push(content.title);
        }
        for (const row of content.rows) {
          const line = document.createElement("div");
          line.textContent = `${row.label}: ${row.value}`;
          card.append(line);
          accessibleText.push(line.textContent);
        }
      }
      element.replaceChildren(card);
      accessibleName = accessibleText.join("\n");
    };
    const instance = tooltip.create({
      ...context,
      bodyChange: () => renderBody,
    });
    return {
      ...instance,
      paint(paintContext) {
        instance.paint(paintContext);
        body?.parentElement?.setAttribute("aria-label", accessibleName);
      },
    };
  },
};
