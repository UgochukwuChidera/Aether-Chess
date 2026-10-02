/**
 * gameStore.toast.test.ts — P2-T19(b): `toast-${Date.now()}` collides within
 * the same millisecond; it is the React key and the dismiss filter.
 *
 * Fail-first contract: with the clock pinned (both pushes land in the same
 * millisecond) the test asserts the FIXED behaviour — distinct ids, so
 * dismissing one leaves the other. FAILS on the pre-fix code (shared id:
 * the `not.toBe` fails, and dismiss removes both).
 *
 * Id shape mirrors electron/main.ts:261
 * (`${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGameStore } from "./gameStore";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  useGameStore.getState().resetGame();
  useGameStore.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("P2-T19 toast key uniqueness", () => {
  it("two toasts in the same millisecond get distinct ids", () => {
    useGameStore.getState().pushToast("first", "info");
    useGameStore.getState().pushToast("second", "info");
    const toasts = useGameStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.id).not.toBe(toasts[1]?.id);
  });

  it("dismissing one same-millisecond toast leaves the other", () => {
    useGameStore.getState().pushToast("first", "info");
    useGameStore.getState().pushToast("second", "info");
    const toasts = useGameStore.getState().toasts;
    useGameStore.getState().dismissToast(toasts[0]?.id as string);
    const rest = useGameStore.getState().toasts;
    expect(rest).toHaveLength(1);
    expect(rest[0]?.message).toBe("second");
  });
});
