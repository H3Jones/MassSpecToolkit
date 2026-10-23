import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { initSync } from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";
import type { TxtFormat } from "../src/core/types.ts";
import { createMassSpectrumChart } from "../src/charts/index.ts";

beforeAll(async () => {
  const bytes = await readFile(new URL("../src/generated/wasm/ms_wasm_bg.wasm", import.meta.url));
  initSync({ module: bytes });
});

const whitespaceSpec: TxtFormat = {
  delimiter: "whitespace",
  skip_lines: 0,
  column_count: 3,
  mz_column: 0,
  intensity_column: 1,
  signal_to_noise_column: null,
};

describe("text spectra", () => {
  it("round-trips a guessed layout without assuming S/N and preserves measurements", async () => {
    const input = "57\t250\t0.00015\r\n\r\n43\t1000\t0.00018\n57\t0\t0\n";
    const spec = await api.guessTxtFormat(input);
    expect(spec).toEqual({ ...whitespaceSpec, delimiter: { character: "\t" } });
    const expected = {
      peaks: [
        { mz: 57, intensity: 250, signal_to_noise: null },
        { mz: 43, intensity: 1000, signal_to_noise: null },
        { mz: 57, intensity: 0, signal_to_noise: null },
      ],
    };
    await expect(api.parseTxt(input)).resolves.toEqual(expected);
    const result = await api.parseTxt(input, spec);
    expect(result).toEqual(expected);
    const chart = createMassSpectrumChart(
      result.peaks.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
    );
    expect(chart.series).toMatchObject([
      {
        data: [
          { value: [57, 25], mz: 57, int: 250 },
          { value: [43, 100], mz: 43, int: 1000 },
          { value: [57, 0], mz: 57, int: 0 },
        ],
      },
    ]);
  });

  it("supports recognized headers, explicit mappings, and empty explicit layouts", async () => {
    await expect(api.parseTxt("m/z,I,Res.\n202.68987,454818,1906786\n")).resolves.toEqual({
      peaks: [{ mz: 202.68987, intensity: 454818, signal_to_noise: null }],
    });
    await expect(api.parseTxt("Intensity,m/z,S/N\n250,57,2\n")).resolves.toEqual({
      peaks: [{ mz: 57, intensity: 250, signal_to_noise: 2 }],
    });
    await expect(
      api.parseTxt("43\t1000\t10\n57 250 0\n", {
        ...whitespaceSpec,
        signal_to_noise_column: 2,
      }),
    ).resolves.toEqual({
      peaks: [
        { mz: 43, intensity: 1000, signal_to_noise: 10 },
        { mz: 57, intensity: 250, signal_to_noise: 0 },
      ],
    });
    await expect(api.parseTxt(" \r\n\t\n", whitespaceSpec)).resolves.toEqual({ peaks: [] });
  });

  it("surfaces guessing, spec, and full-file validation errors", async () => {
    const spec = { ...whitespaceSpec, signal_to_noise_column: 2 };
    for (const [input, message] of [
      ["43 1000 10\n\n57 250", "line 3: expected 3 columns"],
      ["43 1000 10\n57 bad 2", 'line 2, column 2: "bad" is not a valid number'],
      ["0 1 1", "line 1: invalid peak: peak m/z"],
      ["-1 1 1", "line 1: invalid peak: peak m/z"],
      ["NaN 1 1", "line 1: invalid peak: peak m/z"],
      ["inf 1 1", "line 1: invalid peak: peak m/z"],
      ["1 -1 1", "line 1: invalid peak: peak intensity"],
      ["1 NaN 1", "line 1: invalid peak: peak intensity"],
      ["1 1 -1", "line 1: invalid peak: peak S/N"],
      ["1 1 inf", "line 1: invalid peak: peak S/N"],
      ["1 2 3 4", "line 1: expected 3 columns"],
    ]) {
      await expect(api.parseTxt(input, spec)).rejects.toThrow(message);
    }
    await expect(api.guessTxtFormat(" \n")).rejects.toThrow("no data rows");
    await expect(api.parseTxt("m/z intensity S/N")).rejects.toThrow("no data rows");
    await expect(api.parseTxt("unknown header\n1 2")).rejects.toThrow("cannot guess");
    await expect(api.parseTxt("1 2 3", { ...spec, mz_column: 3 })).rejects.toThrow(
      "invalid text format spec",
    );
    await expect(
      api.parseTxt("1 2 3", { ...spec, delimiter: { character: "invalid" } }),
    ).rejects.toThrow();
    await expect(api.parseTxt(`${"1 2 3\n".repeat(32)}4 bad 6`)).rejects.toThrow(
      'line 33, column 2: "bad" is not a valid number',
    );
  });
});
