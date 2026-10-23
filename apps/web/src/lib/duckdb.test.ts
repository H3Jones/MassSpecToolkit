import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSpectrumDatabase } from "./duckdb";

const mocks = vi.hoisted(() => ({
  instantiate: vi.fn(async () => null),
  open: vi.fn(async () => {}),
  connect: vi.fn(async () => ({})),
  detach: vi.fn(),
}));

vi.mock("@duckdb/duckdb-wasm", () => ({
  selectBundle: async () => ({ mainModule: "/duckdb.wasm", mainWorker: "/duckdb.worker.js" }),
  ConsoleLogger: class {},
  LogLevel: { WARNING: 2 },
  AsyncDuckDB: class {
    instantiate = mocks.instantiate;
    open = mocks.open;
    connect = mocks.connect;
    detach = mocks.detach;
  },
}));

class TestWorker extends EventTarget {
  static latest: TestWorker;
  terminate = vi.fn();
  constructor() {
    super();
    TestWorker.latest = this;
  }
  postMessage() {
    queueMicrotask(() => this.message({ type: "ms-duckdb-ready" }));
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("Worker", TestWorker);
  vi.stubGlobal("location", { href: "http://localhost/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spectrum database worker lifecycle", () => {
  it("waits for the worker and initializes an in-memory database", async () => {
    const source = await createSpectrumDatabase();
    expect(mocks.instantiate).toHaveBeenCalledWith("http://localhost/duckdb.wasm");
    expect(mocks.open).toHaveBeenCalledWith({
      path: ":memory:",
      query: { castBigIntToDouble: true },
    });
    expect(await source.run(async () => 42)).toBe(42);
    source.dispose();
    expect(TestWorker.latest.terminate).toHaveBeenCalledOnce();
  });

  it("surfaces loader rejections outside DuckDB's request protocol and terminates the worker", async () => {
    mocks.instantiate.mockImplementationOnce(
      () =>
        new Promise<null>(() => {
          queueMicrotask(() =>
            TestWorker.latest.message({ type: "ms-duckdb-error", message: "Failed to fetch WASM" }),
          );
        }),
    );
    await expect(createSpectrumDatabase()).rejects.toThrow("Failed to fetch WASM");
    expect(TestWorker.latest.terminate).toHaveBeenCalledOnce();
    expect(mocks.detach).toHaveBeenCalledOnce();
  });

  it.each(["error", "messageerror"])("rejects pending queries after a worker %s", async (type) => {
    const source = await createSpectrumDatabase();
    const pending = source.run(() => new Promise<never>(() => {}));
    TestWorker.latest.dispatchEvent(new Event(type));
    await expect(pending).rejects.toThrow(
      type === "error" ? "stopped unexpectedly" : "unreadable message",
    );
    await expect(source.run(async () => 1)).rejects.toThrow();
    source.dispose();
  });

  it("rejects pending work when a replaced database is disposed", async () => {
    const source = await createSpectrumDatabase();
    const pending = source.run(() => new Promise<never>(() => {}));
    source.dispose();
    await expect(pending).rejects.toThrow("closed");
    await expect(source.run(async () => 1)).rejects.toThrow("closed");
  });
});
