import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { spectrumReaders } from "@/lib/spectrum";
import { SpectrumReaderDescription } from "./spectrum-reader-description";

describe("spectrum reader descriptions", () => {
  it("provides JSX help for every registered reader", () => {
    for (const reader of spectrumReaders) {
      const html = renderToStaticMarkup(
        createElement(SpectrumReaderDescription, { readerId: reader.id }),
      );
      expect(html).toContain("<p>");
      expect(html).not.toContain("&lt;p&gt;");
    }
  });

  it("renders supported header aliases as a semantic list", () => {
    const html = renderToStaticMarkup(
      createElement(SpectrumReaderDescription, { readerId: "txt" }),
    );
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain("<strong>S/N:</strong>");
    expect(html).toContain("m/z or mz");
    expect(html).toContain("Intensity, I, or Abundance");
    expect(html).toContain("S/N, SN, or SNR");
    expect(html).toContain("RT, RetentionTime, Retention time, or retention_time");
  });

});
