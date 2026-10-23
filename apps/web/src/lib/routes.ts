import { tools, type Tool } from "./tools";

export type Route =
  | { kind: "home" }
  | { kind: "spectrum" }
  | { kind: "tool"; tool: Tool }
  | { kind: "not-found" };

export function resolveRoute(hash: string): Route {
  if (!hash.startsWith("#/") || hash === "#/") return { kind: "home" };
  if (hash === "#/spectrum") return { kind: "spectrum" };
  const tool = tools.find((candidate) => hash === `#/tools/${candidate.id}`);
  return tool ? { kind: "tool", tool } : { kind: "not-found" };
}

export function subscribeToHashChange(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
