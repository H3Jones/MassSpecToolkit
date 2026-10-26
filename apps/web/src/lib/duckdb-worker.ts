/// <reference lib="webworker" />
export {};

declare const self: DedicatedWorkerGlobalScope;

// DuckDB's loader can reject outside its request protocol (for example, a failed WASM fetch).
self.addEventListener("unhandledrejection", (event) => {
  self.postMessage({
    type: "ms-duckdb-error",
    message: event.reason instanceof Error ? event.reason.message : String(event.reason),
  });
  event.preventDefault();
});

self.addEventListener(
  "message",
  async (event) => {
    const message: unknown = event.data;
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      message.type !== "ms-duckdb-load" ||
      !("url" in message) ||
      typeof message.url !== "string"
    ) {
      throw new Error("Invalid spectrum database worker initialization.");
    }
    await import(/* @vite-ignore */ message.url);
    self.postMessage({ type: "ms-duckdb-ready" });
  },
  { once: true },
);
