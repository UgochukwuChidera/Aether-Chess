/**
 * Unit tests for the preload subscribe/unsubscribe API (P2-T03).
 *
 * Fail-first contract: `preload.ts` registers `onBackendError` /
 * `onBackendClosed` with bare `ipcRenderer.on` and no removal counterpart,
 * and `removeAnalysisListeners` uses `removeAllListeners` — so on the
 * pre-fix code no subscribe function returns an unsubscribe closure (test 1
 * fails) and unmounting one view kills the co-mounted sibling's
 * subscription (test 3 fails).
 *
 * Design note: the first attempt at this item used a preload-side map keyed
 * by the caller's callback, with removal by reference — and the e2e caught
 * it leaking: contextBridge mints a fresh proxy per crossing, so the
 * reference handed back at cleanup never matches the one stored at
 * subscribe time (every lookup missed while entries accumulated). Each
 * subscribe function therefore returns its own unsubscribe closure, which
 * captures the in-preload wrapper where identity is stable.
 *
 * Runs under plain Node (no Electron): the `electron` module is stubbed via
 * a `Module._load` hook installed BEFORE the compiled preload is required
 * (a static `import './preload'` would hoist above the hook, so the require
 * goes through `createRequire` at test time). `contextBridge` captures the
 * exposed API object for direct invocation.
 */
import { strict as assert } from 'assert';
import { EventEmitter } from 'node:events';
import { createRequire, Module } from 'node:module';
import { describe, it } from 'node:test';

type Unsubscribe = () => void;

class FakeIpcRenderer extends EventEmitter {}

const fakeIpcRenderer = new FakeIpcRenderer();

let exposedApi: Record<string, (...args: never[]) => unknown> = {};

const fakeElectron = {
  ipcRenderer: fakeIpcRenderer,
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, (...args: never[]) => unknown>) => {
      exposedApi = api;
    },
  },
};

type LoadHook = (request: string, parent?: unknown, isMain?: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: LoadHook };
const originalLoad = moduleWithLoad._load.bind(Module);
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad(request, parent, isMain);
};

createRequire(__filename)('./preload');

function listenerCount(channel: string): number {
  return fakeIpcRenderer.listenerCount(channel);
}

function reset(): void {
  fakeIpcRenderer.removeAllListeners();
}

function onBackendClosed(cb: () => void): Unsubscribe {
  return (exposedApi.onBackendClosed as unknown as (cb: () => void) => Unsubscribe)(cb);
}

function onBackendError(cb: (msg: string) => void): Unsubscribe {
  return (exposedApi.onBackendError as unknown as (cb: (msg: string) => void) => Unsubscribe)(cb);
}

function onAnalysisUpdate(cb: (data: unknown) => void): Unsubscribe {
  return (exposedApi.onAnalysisUpdate as unknown as (cb: (data: unknown) => void) => Unsubscribe)(cb);
}

describe('preload subscribe/unsubscribe API (P2-T03)', () => {
  it('each subscribe function returns its own unsubscribe closure', () => {
    reset();
    const unsubError = onBackendError(() => {});
    const unsubClosed = onBackendClosed(() => {});
    const unsubAnalysis = onAnalysisUpdate(() => {});
    assert.equal(typeof unsubError, 'function');
    assert.equal(typeof unsubClosed, 'function');
    assert.equal(typeof unsubAnalysis, 'function');
    assert.equal(listenerCount('backend-error'), 1);
    assert.equal(listenerCount('backend-closed'), 1);
    assert.equal(listenerCount('analysis-update'), 1);
    unsubError();
    unsubClosed();
    unsubAnalysis();
    assert.equal(listenerCount('backend-error'), 0);
    assert.equal(listenerCount('backend-closed'), 0);
    assert.equal(listenerCount('analysis-update'), 0);
  });

  it('distinct callbacks coexist on one channel', () => {
    reset();
    const seen: string[] = [];
    const unsubs = [
      onBackendError((msg) => {
        seen.push(`cb1:${msg}`);
      }),
      onBackendError((msg) => {
        seen.push(`cb2:${msg}`);
      }),
    ];
    assert.equal(listenerCount('backend-error'), 2);
    fakeIpcRenderer.emit('backend-error', {}, 'boom');
    assert.deepEqual(seen, ['cb1:boom', 'cb2:boom']);
    unsubs.forEach((unsub) => unsub());
  });

  it('unsubscribing one subscription leaves the co-mounted sibling (co-mount hazard)', () => {
    reset();
    const seen: string[] = [];
    const unsubPlay = onBackendClosed(() => {
      seen.push('play');
    });
    onBackendClosed(() => {
      seen.push('app');
    });
    assert.equal(listenerCount('backend-closed'), 2);
    // PlayView unmounts: only its own wrapper goes; App's survives.
    unsubPlay();
    assert.equal(listenerCount('backend-closed'), 1);
    fakeIpcRenderer.emit('backend-closed');
    assert.deepEqual(seen, ['app']);
  });

  it('double-unsubscribe is a safe no-op', () => {
    reset();
    const unsub = onBackendClosed(() => {});
    assert.equal(listenerCount('backend-closed'), 1);
    unsub();
    assert.equal(listenerCount('backend-closed'), 0);
    assert.doesNotThrow(() => unsub());
    assert.equal(listenerCount('backend-closed'), 0);
  });

  it('analysis unsubscribe removes only its own wrapper', () => {
    reset();
    const seen: string[] = [];
    const unsubPlay = onAnalysisUpdate(() => {
      seen.push('play');
    });
    onAnalysisUpdate(() => {
      seen.push('analysis');
    });
    assert.equal(listenerCount('analysis-update'), 2);
    unsubPlay();
    assert.equal(listenerCount('analysis-update'), 1);
    fakeIpcRenderer.emit('analysis-update', {}, { callback_id: 'x' });
    assert.deepEqual(seen, ['analysis']);
  });

  it('backend-error and backend-closed unsubscribe independently', () => {
    reset();
    let errorCalls = 0;
    let closedCalls = 0;
    const unsubError = onBackendError(() => {
      errorCalls += 1;
    });
    onBackendClosed(() => {
      closedCalls += 1;
    });
    unsubError();
    fakeIpcRenderer.emit('backend-error', {}, 'boom');
    fakeIpcRenderer.emit('backend-closed');
    assert.equal(errorCalls, 0);
    assert.equal(closedCalls, 1);
  });
});
