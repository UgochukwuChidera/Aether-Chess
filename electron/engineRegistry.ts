/**
 * Electron-facing Stockfish discovery.
 *
 * All of the actual logic lives in {@link ./engineDiscovery}, which knows
 * nothing about Electron and can therefore be unit tested under plain Node.
 * This module only answers the questions that genuinely need Electron: where
 * the app's folders are and which binary shipped with the package.
 */
import { app } from 'electron';
import * as path from 'path';

import {
  createEngineDiscovery,
  isAutoPath,
  isExecutableFile,
  ensureExecutable,
  type EngineCandidate,
  type EngineSource,
} from './engineDiscovery';

export type { EngineCandidate, EngineSource };
export { isAutoPath, isExecutableFile, ensureExecutable };

/** The folder shipped alongside the app that players can drop binaries into. */
export function appEnginesDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'engines') : path.join(__dirname, '..', '..', 'engines');
}

/** Per-user engines folder — writable even when the app folder is not. */
export function userEnginesDir(): string {
  return path.join(app.getPath('userData'), 'engines');
}

/** Binaries that shipped inside the package, if this is a packaged build. */
function bundledCandidates(): string[] {
  if (!app.isPackaged) return [];
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return [
    path.join(process.resourcesPath, 'backend', `stockfish${suffix}`),
    path.join(process.resourcesPath, `stockfish${suffix}`),
  ];
}

let discovery: ReturnType<typeof createEngineDiscovery> | null = null;

/**
 * Built on first use rather than at import time: `app.getPath('userData')` is
 * only valid once Electron is ready, and this module is imported long before
 * that.
 */
function getDiscovery(): ReturnType<typeof createEngineDiscovery> {
  if (!discovery) {
    discovery = createEngineDiscovery({
      appEnginesDir: appEnginesDir(),
      userEnginesDir: userEnginesDir(),
      bundledCandidates: bundledCandidates(),
      pathEnv: process.env.PATH ?? '',
    });
  }
  return discovery;
}

export function discoverEngines(configured?: string | null): Promise<EngineCandidate[]> {
  return getDiscovery().discoverEngines(configured);
}

export function resolveEnginePath(configured?: string | null): Promise<string | null> {
  return getDiscovery().resolveEnginePath(configured);
}

export function ensureEngineDirs(): void {
  getDiscovery().ensureEngineDirs();
}
