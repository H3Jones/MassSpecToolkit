import { describe, expect, it } from "vite-plus/test";
import { resolveRoute } from "./routes";
import { tools, toolHref } from "./tools";

describe("static-host routes", () => {
  it.each(["", "#", "#/", "#toolkit", "#developers", "#main"])(
    "preserves the home page and its section anchors: %s",
    (hash) => {
      expect(resolveRoute(hash)).toEqual({ kind: "home" });
    },
  );

  it.each(tools)("resolves the $id tool link", (tool) => {
    expect(resolveRoute(toolHref(tool))).toEqual({ kind: "tool", tool });
    expect(toolHref(tool)).toMatch(/^#\/tools\/[a-z-]+$/);
  });

  it.each(["#/tools/unknown", "#/unknown", "#/tools", "#/tools/ion-calculator/extra"])(
    "reports unknown page routes: %s",
    (hash) => {
      expect(resolveRoute(hash)).toEqual({ kind: "not-found" });
    },
  );
});
