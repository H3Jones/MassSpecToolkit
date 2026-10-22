import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { initSync } from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";
import { createMassSpectrumChart } from "../src/charts/index.ts";

beforeAll(async () => {
  const bytes = await readFile(new URL("../src/generated/wasm/ms_wasm_bg.wasm", import.meta.url));
  initSync({ module: bytes });
});

describe("ASC spectra", () => {
  it("preserves original intensities, signal-to-noise, order, and duplicate m/z values", async () => {
    await expect(
      api.parseAsc("204.55546\t1842229\t0.00015\r\n\r\n202.85354 917992 0.00018\n202.85354 0 0\n"),
    ).resolves.toEqual({
      peaks: [
        { mz: 204.55546, intensity: 1842229, signal_to_noise: 0.00015 },
        { mz: 202.85354, intensity: 917992, signal_to_noise: 0.00018 },
        { mz: 202.85354, intensity: 0, signal_to_noise: 0 },
      ],
    });
  });

  it("maps parsed intensities to the existing relative-intensity chart", async () => {
    const result = await api.parseAsc("43 1000 10\n57 250 2\n");
    const chart = createMassSpectrumChart(
      result.peaks.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
    );
    expect(chart.series).toMatchObject([
      {
        data: [
          { value: [43, 100], mz: 43, int: 1000 },
          { value: [57, 25], mz: 57, int: 250 },
        ],
      },
    ]);
    expect(result.peaks[1]).toEqual({ mz: 57, intensity: 250, signal_to_noise: 2 });
  });

  it("allows empty peak lists at the parser level", async () => {
    await expect(api.parseAsc(" \r\n\t\n")).resolves.toEqual({ peaks: [] });
  });

  it.each([
    ["43 1000 10\n\n57 250", "line 3: expected 3 columns"],
    ["43 1000 10\n57 bad 2", 'line 2, column 2: "bad" is not a valid number'],
    ["m/z intensity S/N", "line 1, column 1"],
    ["0 1 1", "line 1: invalid peak: peak m/z"],
    ["-1 1 1", "line 1: invalid peak: peak m/z"],
    ["NaN 1 1", "line 1: invalid peak: peak m/z"],
    ["inf 1 1", "line 1: invalid peak: peak m/z"],
    ["1 -1 1", "line 1: invalid peak: peak intensity"],
    ["1 NaN 1", "line 1: invalid peak: peak intensity"],
    ["1 1 -1", "line 1: invalid peak: peak S/N"],
    ["1 1 inf", "line 1: invalid peak: peak S/N"],
    ["1 2 3 4", "line 1: expected 3 columns"],
  ])("rejects invalid data %j with the Rust reader's diagnostics", async (text, message) => {
    await expect(api.parseAsc(text)).rejects.toThrow(message);
  });
});
