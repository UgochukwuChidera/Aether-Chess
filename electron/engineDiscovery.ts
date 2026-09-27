/**
 * Stockfish discovery, with no dependency on Electron.
 *
 * Everything here is driven by an explicit {@link EngineContext} rather than
 * reaching for `process.env` or the `app` module, which is what lets the same
 * logic be unit tested under plain Node — importing `electron` outside an
 * Electron process throws.
 *
 * Resolution order for the engine executable:
 *   1. An explicit path the user configured (their deliberate choice wins).
 *   2. A bare command name such as "stockfish" — treated as *auto*, not as a
 *      choice, so it resolves through the search order below.
 *   3. PATH, so a system-wide install just works.
 *   4. The app's `engines/` folder.
 *   5. The per-user engines folder, so a non-technical player can drop a
 *      downloaded binary there without touching the installation directory
 *      (which may be read-only or owned by root).
 *   6. A binary bundled with the packaged app.
 *
 * Every candidate is probed by asking the engine to identify itself over UCI,
 * which is what lets several Stockfish versions coexist and be listed
 * individually instead of one silently winning. The engine's own answer is
 * trusted over the filename, because release archives have shipped binaries
 * that disagree with their own version tag.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';

export type EngineSource = 'configured' | 'path' | 'app-engines' | 'user-engines' | 'bundled';

export type EngineCandidate = {
  /** Absolute path to the executable. */
  path: string;
  /** Engine's self-reported id name, e.g. "Stockfish 19". */
  name: string;
  /** Parsed version numbers, e.g. [19] — empty when the engine omits them. */
  version: number[];
  /** Human-readable version, e.g. "19". Empty when unknown. */
  versionLabel: string;
  source: EngineSource;
  /** True when this is the entry the resolver would pick. */
  selected: boolean;
};

export type EngineContext = {
  /** Folder shipped alongside the app that players can drop binaries into. */
  appEnginesDir: string;
  /** Per-user engines folder — writable even when the app folder is not. */
  userEnginesDir: string;
  /** Absolute paths shipped with the packaged app, if any. */
  bundledCandidates: string[];
  /** PATH to search for a bare command name. */
  pathEnv: string;
  /**
   * How long a single probe may take. Generous, because a cold 100 MB engine
   * needs over a second to start and several probe concurrently; discovery
   * only pays it once, since successes are cached.
   */
  probeTimeoutMs?: number;
};

/** Names treated as "let the app decide" rather than a real configured path. */
const AUTO_NAMES = new Set(['', 'stockfish', 'auto', 'default']);

const DEFAULT_PROBE_TIMEOUT_MS = 8000;

const EXECUTABLE_PERMISSION_MASK = 0o111;

const isWindows = (): boolean => process.platform === 'win32';

/** Values that mean "the user has not chosen a specific engine". */
export function isAutoPath(candidate: string | null | undefined): boolean {
  if (candidate == null) return true;
  const trimmed = candidate.trim();
  if (AUTO_NAMES.has(trimmed.toLowerCase())) return true;
  // A bare name with no directory separator is a PATH lookup, not a real path.
  return !trimmed.includes('/') && !trimmed.includes('\\');
}

export function isExecutableFile(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    if (isWindows()) {
      const ext = path.extname(filePath).toLowerCase();
      return ['.exe', '.bat', '.cmd'].includes(ext);
    }
    return (stats.mode & EXECUTABLE_PERMISSION_MASK) !== 0;
  } catch {
    return false;
  }
}

/**
 * Grant the execute bit. Browsers do not preserve it, so a binary the user
 * dragged out of a download is frequently not runnable until this is set.
 */
export function ensureExecutable(filePath: string): void {
  if (isWindows()) return;
  try {
    const stats = fs.statSync(filePath);
    if (stats.isFile() && (stats.mode & 0o100) === 0) {
      fs.chmodSync(filePath, stats.mode | 0o111);
    }
  } catch {
    /* nothing useful to do if the file is not ours to change */
  }
}

/** Executable names worth probing on PATH, newest-version-first. */
function pathCommandNames(): string[] {
  const suffix = isWindows() ? '.exe' : '';
  const names = ['stockfish'];
  // Packaged builds from distributions sometimes expose a versioned name.
  for (let v = 20; v >= 10; v -= 1) names.push(`stockfish-${v}`);
  return names.map((n) => `${n}${suffix}`);
}

/** Locate a bare command name on PATH without importing shell helpers. */
function whichSync(command: string, pathEnv: string): string | null {
  if (isWindows()) {
    // `where` is the Windows equivalent of `which`.
    try {
      const result = spawnSync('where', [command], {
        encoding: 'utf-8',
        windowsHide: true,
      });
      if (result.status === 0) {
        const first = (result.stdout ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)[0];
        if (first) return first;
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** Files in a directory that look like engine binaries. */
function engineFilesIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (isWindows()) {
      if (/\.(exe|bat|cmd)$/i.test(name)) found.push(path.join(dir, name));
    } else if (name.includes('stockfish')) {
      // No extension convention on Unix; a name containing "stockfish" is a
      // safe filter and avoids picking up unrelated files dropped alongside.
      found.push(path.join(dir, name));
    }
  }
  return found;
}

/** Fall back to a version guessed from a string, e.g. "stockfish-19" or "Stockfish 19". */
export function versionFromName(text: string): number[] {
  const match = /(\d+(?:\.\d+)*)/.exec(path.basename(text));
  if (!match) return [];
  return match[1]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((n) => !Number.isNaN(n));
}

/** Newest version first; unknown versions last. */
export function byNewestFirst(a: EngineCandidate, b: EngineCandidate): number {
  const aKnown = a.version.length > 0;
  const bKnown = b.version.length > 0;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i += 1) {
    const av = a.version[i];
    const bv = b.version[i];
    if (av === bv) continue;
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    return bv - av;
  }
  return a.name.localeCompare(b.name);
}

export function createEngineDiscovery(ctx: EngineContext) {
  const probeTimeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  /** Probed identities, keyed by path+size+mtime. Only successes are stored. */
  const identityCache = new Map<string, string>();

  /**
   * Ask a binary to identify itself.
   *
   * UCI engines only emit `id name` in response to the `uci` command, so we
   * send it and read until the answer arrives.
   */
  function probeIdentity(binPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      // Holder rather than a bare `let`: the timer is created after `finish` is
      // defined, but must still be cleared so a finished probe does not keep
      // the event loop alive for the rest of the timeout.
      const pending: { timer?: NodeJS.Timeout } = {};
      let child: ReturnType<typeof spawn> | null = null;

      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        try {
          child?.kill();
        } catch {
          /* already gone */
        }
        resolve(value);
      };

      try {
        child = spawn(binPath, [], {
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
      } catch {
        resolve(null);
        return;
      }

      pending.timer = setTimeout(() => finish(null), probeTimeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
        const match = /id name\s+(.+)/i.exec(stdout);
        if (match) finish(match[1].trim());
      });
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));

      // Without this the engine never identifies itself.
      try {
        child.stdin?.write('uci\n');
      } catch {
        finish(null);
      }
    });
  }

  /**
   * Probe identity, memoised on the file's path, size and mtime.
   *
   * Only successful probes are cached: a timeout or a wedged binary is a
   * transient condition, and remembering it would leave the engine permanently
   * mislabelled until the file happened to be rewritten.
   */
  async function identityCached(binPath: string): Promise<string | null> {
    let key: string;
    try {
      const stats = fs.statSync(binPath);
      key = `${path.resolve(binPath)}:${stats.size}:${stats.mtimeMs}`;
    } catch {
      return null;
    }

    const cached = identityCache.get(key);
    if (cached !== undefined) return cached;

    const identity = await probeIdentity(binPath);
    if (identity) identityCache.set(key, identity);
    return identity;
  }

  function buildCandidate(binPath: string, source: EngineSource, identity: string | null): EngineCandidate {
    const version = identity ? versionFromName(identity) : versionFromName(binPath);
    return {
      path: binPath,
      name: identity ?? path.basename(binPath),
      version,
      versionLabel: version.join('.'),
      source,
      selected: false,
    };
  }

  /**
   * Every engine we can find, newest first. Order of the returned list is the
   * preference order used by {@link resolveEnginePath}.
   */
  async function discoverEngines(configured?: string | null): Promise<EngineCandidate[]> {
    const raw: { binPath: string; source: EngineSource }[] = [];
    const seen = new Set<string>();

    const add = (binPath: string, source: EngineSource) => {
      // Repair the execute bit before checking it: a binary dragged out of a
      // browser download folder is very often not executable yet.
      ensureExecutable(binPath);
      if (!isExecutableFile(binPath)) return;
      const abs = path.resolve(binPath);
      const key = isWindows() ? abs.toLowerCase() : abs;
      if (seen.has(key)) return;
      seen.add(key);
      raw.push({ binPath: abs, source });
    };

    // 1. An explicit, real path the user configured.
    if (configured && !isAutoPath(configured)) {
      add(configured, 'configured');
    }

    // 2. PATH.
    for (const command of pathCommandNames()) {
      const located = whichSync(command, ctx.pathEnv);
      if (located) add(located, 'path');
    }

    // 3. The app's own engines folder.
    for (const file of engineFilesIn(ctx.appEnginesDir)) add(file, 'app-engines');

    // 4. The per-user engines folder.
    for (const file of engineFilesIn(ctx.userEnginesDir)) add(file, 'user-engines');

    // 5. A binary bundled with the packaged app.
    for (const candidate of ctx.bundledCandidates) add(candidate, 'bundled');

    // Starting engines is the slow part, so probe them concurrently.
    const identities = await Promise.all(raw.map((entry) => identityCached(entry.binPath)));
    const found = raw.map((entry, index) => buildCandidate(entry.binPath, entry.source, identities[index]));
    return found.sort(byNewestFirst);
  }

  /**
   * The engine path to actually use, or null when none was found.
   * See the module comment for the full order.
   */
  async function resolveEnginePath(configured?: string | null): Promise<string | null> {
    // An explicit path is the user's deliberate choice; honour it even if it is
    // not discoverable by the generic search, and fail loudly later rather than
    // silently substituting a different engine.
    if (configured && !isAutoPath(configured)) {
      const abs = path.isAbsolute(configured) ? configured : path.resolve(configured);
      return isExecutableFile(abs) ? abs : null;
    }

    const candidates = await discoverEngines(configured);
    return candidates.length > 0 ? candidates[0].path : null;
  }

  /** Ensure the folders a player is told to drop binaries into exist. */
  function ensureEngineDirs(): void {
    for (const dir of [ctx.appEnginesDir, ctx.userEnginesDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* read-only install: the user folder will still be created */
      }
    }
  }

  return {
    discoverEngines,
    resolveEnginePath,
    ensureEngineDirs,
    clearIdentityCache: (): void => identityCache.clear(),
    /** Test seam: how many identities are memoised. */
    identityCacheSize: (): number => identityCache.size,
  };
}

export type EngineDiscovery = ReturnType<typeof createEngineDiscovery>;
