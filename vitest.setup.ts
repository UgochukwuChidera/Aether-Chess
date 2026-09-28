import "@testing-library/jest-dom/vitest";

// jsdom lacks ResizeObserver (used by renderer/src/views/PlayView.tsx).
// Minimal viable stub: constructor accepts the callback, methods are no-ops.
class ResizeObserverStub {
  constructor(_callback?: ResizeObserverCallback) {}
  observe(_target?: Element | null) {}
  unobserve(_target?: Element | null) {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}
