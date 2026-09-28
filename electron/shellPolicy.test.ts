/**
 * Unit tests for the shell policy (P2-T06).
 *
 * Fail-first contract: `electron/shellPolicy.ts` does not exist yet, so
 * `npm run test:electron` fails at the `tsc -p tsconfig.test.json` step
 * (TS2307: cannot find module './shellPolicy') before any assertion runs.
 *
 * Design note: the policy lives in a zero-electron-dep module (P0-T09
 * precedent — `main.ts` imports `electron` and throws under plain Node),
 * the same shape as `engineDiscovery.ts`. The ipcMain handlers stay thin:
 * resolve roots (userData, history dir, engines dirs) → policy →
 * proceed-or-throw.
 *
 * Runs under plain Node (no Electron).
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { isAllowedOpenUrl, isPathWithinRoots } from "./shellPolicy";

describe("isAllowedOpenUrl (P2-T06)", () => {
  it("accepts the real renderer caller shape (Stockfish download link)", () => {
    assert.equal(
      isAllowedOpenUrl("https://stockfishchess.org/download/"),
      true,
    );
  });

  it("accepts https links generally, case-insensitively", () => {
    assert.equal(isAllowedOpenUrl("https://example.com/x?q=1#frag"), true);
    assert.equal(isAllowedOpenUrl("HTTPS://EXAMPLE.COM/"), true);
  });

  it("accepts mailto links", () => {
    assert.equal(isAllowedOpenUrl("mailto:help@example.com"), true);
    assert.equal(isAllowedOpenUrl("mailto:team@aether.chess?subject=Hi"), true);
  });

  it("rejects file:// URLs", () => {
    assert.equal(isAllowedOpenUrl("file:///etc/passwd"), false);
    assert.equal(isAllowedOpenUrl("file://host/share"), false);
  });

  it("rejects smb:// URLs (NTLM-relay vector on Windows)", () => {
    assert.equal(isAllowedOpenUrl("smb://host/share"), false);
  });

  it("rejects UNC paths", () => {
    assert.equal(isAllowedOpenUrl("\\\\host\\share"), false);
  });

  it("rejects javascript: URLs", () => {
    assert.equal(isAllowedOpenUrl("javascript:alert(1)"), false);
  });

  it("rejects http: (allowlist is https: + mailto: only)", () => {
    assert.equal(isAllowedOpenUrl("http://example.com/"), false);
  });

  it("rejects bare paths, empty input, and exotic schemes", () => {
    assert.equal(isAllowedOpenUrl("stockfishchess.org/download/"), false);
    assert.equal(isAllowedOpenUrl("/etc/passwd"), false);
    assert.equal(isAllowedOpenUrl(""), false);
    assert.equal(isAllowedOpenUrl("   "), false);
    assert.equal(isAllowedOpenUrl("ftp://example.com/x"), false);
    assert.equal(isAllowedOpenUrl("data:text/html,hi"), false);
  });

  it("rejects scheme-only https without a host", () => {
    assert.equal(isAllowedOpenUrl("https:foo"), false);
  });

  it("rejects non-string input without throwing", () => {
    assert.equal(isAllowedOpenUrl(undefined as unknown as string), false);
    assert.equal(isAllowedOpenUrl(null as unknown as string), false);
    assert.equal(isAllowedOpenUrl(42 as unknown as string), false);
  });
});

describe("isPathWithinRoots (P2-T06)", () => {
  let sandbox: string;
  let userData: string;
  let historyDir: string;
  let enginesDir: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "aether-shell-"));
    userData = path.join(sandbox, "userData");
    historyDir = path.join(userData, "games");
    enginesDir = path.join(userData, "engines");
    for (const dir of [historyDir, enginesDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const roots = () => [userData, historyDir, enginesDir];

  it("accepts the real renderer flow: a history PGN from get-game-file-path", () => {
    const pgnPath = path.join(historyDir, "1234-abcd.pgn");
    fs.writeFileSync(pgnPath, "*\n");
    assert.equal(isPathWithinRoots(pgnPath, roots()), true);
  });

  it("accepts in-roots paths (settings file, engine binary)", () => {
    assert.equal(
      isPathWithinRoots(path.join(userData, "settings.json"), roots()),
      true,
    );
    assert.equal(
      isPathWithinRoots(path.join(enginesDir, "stockfish"), roots()),
      true,
    );
  });

  it("rejects absolute paths outside every root", () => {
    assert.equal(isPathWithinRoots("/etc/passwd", roots()), false);
    assert.equal(
      isPathWithinRoots(path.join(sandbox, "outside.txt"), roots()),
      false,
    );
  });

  it("rejects `..` escapes that leave all roots", () => {
    // historyDir is <sandbox>/userData/games, so ../.. escapes userData.
    const escape = path.join(historyDir, "..", "..", "escape.txt");
    assert.equal(path.resolve(escape), path.join(sandbox, "escape.txt"));
    assert.equal(isPathWithinRoots(escape, roots()), false);
  });

  it("rejects sibling-prefix escapes (/data-evil vs /data)", () => {
    const data = path.join(sandbox, "data");
    fs.mkdirSync(data, { recursive: true });
    const sibling = path.join(sandbox, "data-evil", "x.pgn");
    assert.equal(isPathWithinRoots(sibling, [data]), false);
    assert.equal(isPathWithinRoots(path.join(data, "x.pgn"), [data]), true);
  });

  it("accepts the root itself", () => {
    assert.equal(isPathWithinRoots(historyDir, roots()), true);
  });

  it("rejects UNC, empty, and non-string input without throwing", () => {
    assert.equal(isPathWithinRoots("\\\\host\\share\\x.pgn", roots()), false);
    assert.equal(isPathWithinRoots("", roots()), false);
    assert.equal(
      isPathWithinRoots(undefined as unknown as string, roots()),
      false,
    );
    assert.equal(isPathWithinRoots("/etc/passwd", []), false);
  });
});
