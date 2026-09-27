/**
 * Unit tests for Stockfish discovery.
 *
 * Runs under plain Node (no Electron), which is why the logic under test lives
 * in engineDiscovery rather than engineRegistry. No real Stockfish is needed:
 * each test writes small stand-in engines that speak the real UCI handshake,
 * including staying silent until sent `uci` — the behaviour that makes probing
 * a real engine non-trivial.
 */
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  byNewestFirst,
  createEngineDiscovery,
  isAutoPath,
  versionFromName,
  type EngineContext,
} from './engineDiscovery';

const isWindows = process.platform === 'win32';
const describePosix = isWindows ? describe.skip : describe;

const UCI_STUB = (name: string) => `#!${process.execPath}
const NAME = ${JSON.stringify(name)};
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\\n')) {
    if (line.trim() === 'uci') {
      process.stdout.write('id name ' + NAME + '\\nid author test\\nuciok\\n');
    }
  }
});
`;

const SILENT_STUB = `#!/bin/sh
# Consumes UCI commands and never answers, like a wedged engine.
exec cat >/dev/null
`;

const DEAD_STUB = `#!/bin/sh
# Exits immediately without identifying itself.
exit 0
`;

interface Sandbox {
  root: string;
  appDir: string;
  userDir: string;
  binDir: string;
  ctx: EngineContext;
}

let sandbox: Sandbox;

function writeStub(dir: string, filename: string, name: string, mode = 0o755): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, UCI_STUB(name), { mode });
  return file;
}

function writeSilentStub(dir: string, filename: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, SILENT_STUB, { mode: 0o755 });
  return file;
}

function writeDeadStub(dir: string, filename: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  fs.writeFileSync(file, DEAD_STUB, { mode: 0o755 });
  return file;
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-engine-'));
  const appDir = path.join(root, 'app-engines');
  const userDir = path.join(root, 'user-engines');
  const binDir = path.join(root, 'bin');
  for (const dir of [appDir, userDir, binDir]) fs.mkdirSync(dir, { recursive: true });
  sandbox = {
    root,
    appDir,
    userDir,
    binDir,
    // A short probe timeout keeps the wedged-engine tests quick; real engines
    // are covered by the slow timeout in production.
    ctx: {
      appEnginesDir: appDir,
      userEnginesDir: userDir,
      bundledCandidates: [],
      pathEnv: binDir,
      // Generous by default: probing starts a real process, and CI runners are
      // slow. Tests that deliberately need a fast failure override this.
      probeTimeoutMs: 10_000,
    },
  };
});

/** A context with per-test overrides, e.g. a short timeout for a wedged engine. */
function ctx(overrides: Partial<EngineContext> = {}): EngineContext {
  return { ...sandbox.ctx, ...overrides };
}

afterEach(() => {
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

describe('isAutoPath', () => {
  it('treats bare names as "auto" rather than a chosen path', () => {
    for (const value of [null, undefined, '', '  ', 'stockfish', 'STOCKFISH', 'auto', 'default']) {
      assert.equal(isAutoPath(value), true, String(value));
    }
  });

  it('treats anything with a directory separator as a real path', () => {
    for (const value of ['/usr/bin/stockfish', './stockfish', 'engines/stockfish-18', 'C:\\sf\\stockfish.exe']) {
      assert.equal(isAutoPath(value), false, value);
    }
  });
});

describe('versionFromName', () => {
  it('parses versions out of both engine names and filenames', () => {
    assert.deepEqual(versionFromName('Stockfish 19'), [19]);
    assert.deepEqual(versionFromName('stockfish-18'), [18]);
    assert.deepEqual(versionFromName('Stockfish 17.1'), [17, 1]);
    assert.deepEqual(versionFromName('stockfish'), []);
  });
});

describe('byNewestFirst', () => {
  const candidate = (name: string, version: number[]) => ({
    path: `/x/${name}`,
    name,
    version,
    versionLabel: version.join('.'),
    source: 'path' as const,
    selected: false,
  });

  it('puts the newest version first', () => {
    const sorted = [candidate('s16', [16]), candidate('s19', [19]), candidate('s17', [17])].sort(byNewestFirst);
    assert.deepEqual(
      sorted.map((c) => c.name),
      ['s19', 's17', 's16'],
    );
  });

  it('sorts unknown versions last rather than first', () => {
    const sorted = [candidate('mystery', []), candidate('s19', [19])].sort(byNewestFirst);
    assert.deepEqual(
      sorted.map((c) => c.name),
      ['s19', 'mystery'],
    );
  });
});

describePosix('discovery', () => {
  it('reports identity only after the uci handshake', async () => {
    const stub = writeStub(sandbox.appDir, 'stockfish', 'Stockfish 17');
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    const found = await discoverEngines();

    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'Stockfish 17');
    assert.deepEqual(found[0].version, [17]);
    assert.equal(found[0].path, stub);
  });

  it('trusts the engine over the filename', async () => {
    // Real case: the official sf_18 archive ships a "universal" binary that
    // is really Stockfish 19, so believing the filename would mislabel it.
    writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 19');
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    const found = await discoverEngines();

    assert.equal(found[0].name, 'Stockfish 19');
    assert.deepEqual(found[0].version, [19]);
  });

  it('lists every version found, newest first', async () => {
    writeStub(sandbox.appDir, 'stockfish-16', 'Stockfish 16');
    writeStub(sandbox.appDir, 'stockfish-19', 'Stockfish 19');
    writeStub(sandbox.userDir, 'stockfish-17', 'Stockfish 17');
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    const found = await discoverEngines();

    assert.deepEqual(
      found.map((c) => c.name),
      ['Stockfish 19', 'Stockfish 17', 'Stockfish 16'],
    );
  });

  it('labels where each engine came from', async () => {
    writeStub(sandbox.binDir, 'stockfish', 'Stockfish 19');
    writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 18');
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    const found = await discoverEngines();
    const byName = Object.fromEntries(found.map((c) => [c.name, c.source]));

    assert.equal(byName['Stockfish 19'], 'path');
    assert.equal(byName['Stockfish 18'], 'app-engines');
  });

  it('finds an engine on PATH', async () => {
    const stub = writeStub(sandbox.binDir, 'stockfish', 'Stockfish 19');
    const { resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.equal(await resolveEnginePath(null), stub);
  });

  it('falls back to the app folder when PATH has no engine', async () => {
    const stub = writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 18');
    const { resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.equal(await resolveEnginePath('stockfish'), stub);
  });

  it('falls back to the user folder when nothing else has an engine', async () => {
    const stub = writeStub(sandbox.userDir, 'stockfish-18', 'Stockfish 18');
    const { resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.equal(await resolveEnginePath('stockfish'), stub);
  });

  it('returns null when no engine exists anywhere', async () => {
    const { discoverEngines, resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.deepEqual(await discoverEngines(), []);
    assert.equal(await resolveEnginePath('stockfish'), null);
  });

  it('honours an explicitly chosen engine even when it is older', async () => {
    writeStub(sandbox.binDir, 'stockfish', 'Stockfish 19');
    const chosen = writeStub(sandbox.appDir, 'stockfish-16', 'Stockfish 16');
    const { discoverEngines, resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.equal(await resolveEnginePath(chosen), chosen);
    const found = await discoverEngines(chosen);
    assert.equal(found[0].name, 'Stockfish 19', 'newest is listed first');
    assert.deepEqual(
      found.filter((c) => c.source === 'configured').map((c) => c.path),
      [chosen],
    );
  });

  it('does not silently substitute another engine for a broken path', async () => {
    writeStub(sandbox.binDir, 'stockfish', 'Stockfish 19');
    const { resolveEnginePath } = createEngineDiscovery(sandbox.ctx);

    assert.equal(await resolveEnginePath(path.join(sandbox.root, 'nope')), null);
  });

  it('ignores unrelated files dropped in the engines folder', async () => {
    writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 18');
    fs.writeFileSync(path.join(sandbox.appDir, 'notes'), 'hello', { mode: 0o755 });
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    const found = await discoverEngines();

    assert.deepEqual(
      found.map((c) => c.name),
      ['Stockfish 18'],
    );
  });

  it('repairs a missing execute bit', async () => {
    const stub = writeStub(sandbox.appDir, 'stockfish', 'Stockfish 17', 0o644);
    const { discoverEngines } = createEngineDiscovery(sandbox.ctx);

    assert.equal(fs.statSync(stub).mode & 0o100, 0);
    const found = await discoverEngines();
    assert.equal(found.length, 1, 'a downloaded binary with no exec bit is still found');
    assert.equal(found[0].name, 'Stockfish 17');
  });

  it('caches successful probes so repeat lookups are free', async () => {
    writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 18');
    const discovery = createEngineDiscovery(sandbox.ctx);

    await discovery.discoverEngines();
    assert.equal(discovery.identityCacheSize(), 1);
    const firstSize = discovery.identityCacheSize();

    await discovery.discoverEngines();
    assert.equal(discovery.identityCacheSize(), firstSize, 'no extra probe was needed');
  });

  it('retries a failed probe instead of remembering the failure', async () => {
    // A stub that exits without answering fails immediately, so this test
    // exercises the cache rather than racing a timeout.
    const dead = writeDeadStub(sandbox.appDir, 'stockfish-18');
    const discovery = createEngineDiscovery(sandbox.ctx);

    const first = await discovery.discoverEngines();
    assert.equal(first[0]?.name, path.basename(dead), 'falls back to the filename');
    assert.equal(discovery.identityCacheSize(), 0, 'a failure must not be cached');

    // The same discovery object, so the cache is genuinely being re-read.
    fs.writeFileSync(dead, UCI_STUB('Stockfish 18'), { mode: 0o755 });
    const second = await discovery.discoverEngines();
    assert.equal(second[0].name, 'Stockfish 18');
  });

  it('does not let a wedged engine hide a working one', async () => {
    writeSilentStub(sandbox.appDir, 'stockfish-19');
    const working = writeStub(sandbox.appDir, 'stockfish-18', 'Stockfish 18');
    // Long enough for the working engine to answer, short enough that the test
    // does not sit on the full production timeout.
    const { discoverEngines, resolveEnginePath } = createEngineDiscovery(ctx({ probeTimeoutMs: 2000 }));

    const found = await discoverEngines();

    assert.ok(
      found.some((c) => c.path === working),
      'the working engine was still found',
    );
    assert.equal(await resolveEnginePath(working), working);
  });

  it('creates the folders a player is told to drop binaries into', () => {
    const ctx: EngineContext = {
      ...sandbox.ctx,
      appEnginesDir: path.join(sandbox.root, 'fresh', 'app'),
      userEnginesDir: path.join(sandbox.root, 'fresh', 'user'),
    };
    const { ensureEngineDirs } = createEngineDiscovery(ctx);

    ensureEngineDirs();

    assert.ok(fs.statSync(ctx.appEnginesDir).isDirectory());
    assert.ok(fs.statSync(ctx.userEnginesDir).isDirectory());
  });
});
