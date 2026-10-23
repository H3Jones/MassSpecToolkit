import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
  postMessage = vi.fn();
  terminate = vi.fn();
}

beforeEach(() => {
  vi.resetModules();
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("worker request failures", () => {
  it.each(["error", "messageerror"])(
    "rejects active requests on %s and restarts for a later request",
    async (type) => {
      const { callClient } = await import("../src/core/index.ts");
      const pending = callClient(() => new Promise<number>(() => {}));
      const rejected = expect(pending).rejects.toThrow(/worker/);
      TestWorker.instances[0].dispatchEvent(new Event(type));
      await rejected;
      expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
      await expect(callClient(() => Promise.resolve(42))).resolves.toBe(42);
      expect(TestWorker.instances).toHaveLength(2);
    },
  );

  it("returns successful results and propagates parser errors", async () => {
    const { callClient } = await import("../src/core/index.ts");
    await expect(callClient(() => Promise.resolve(42))).resolves.toBe(42);
    await expect(
      callClient(() => Promise.reject(new Error("line 2: invalid peak"))),
    ).rejects.toThrow("line 2");
    expect(TestWorker.instances).toHaveLength(1);
  });
});
