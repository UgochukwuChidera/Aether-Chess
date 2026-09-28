/**
 * Shell policy for P2-T06.
 *
 * `shell.openExternal` / `shell.showItemInFolder` used to receive
 * renderer-supplied values unfiltered, so `file://` and `smb://` (an NTLM
 * relay on Windows) were reachable and any filesystem path revealable.
 *
 * Zero Electron (and zero Node-API-beyond-`path`) dependencies, the same
 * shape as `engineDiscovery.ts`: `main.ts` imports `electron` and throws
 * under plain Node (P0-T09 precedent), so the policy must be unit-testable
 * in isolation. The ipcMain handlers stay thin: resolve roots → policy →
 * proceed-or-throw.
 *
 * Case-sensitivity note: the prefix check is byte-exact, which is correct
 * on Linux (this project's platform). On case-insensitive filesystems
 * (Windows/macOS) an attacker-controlled casing variant of a root prefix
 * still resolves inside the same folder, so the check degrades safely —
 * it can only over-accept paths that land in the same directory.
 */
import * as path from "path";

/**
 * Allowlist for `shell.openExternal`: `https:` and `mailto:` only.
 * Everything else — `file:`, `smb:`, UNC, `javascript:`, `http:`,
 * `data:`, bare paths — is rejected.
 */
export function isAllowedOpenUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // `mailto:` carries no host; `https:` without `//host` (e.g. `https:foo`)
  // parses but addresses nothing, so require the full prefix for it.
  if (/^mailto:/i.test(trimmed)) {
    try {
      return new URL(trimmed).protocol.toLowerCase() === "mailto:";
    } catch {
      return false;
    }
  }
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol.toLowerCase() === "https:" && parsed.host !== "";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Root-jail for `shell.showItemInFolder`: the resolved candidate must
 * equal one of the known roots or sit strictly beneath it. The trailing
 * `path.sep` guard keeps `/data-evil/x` from passing as inside `/data`;
 * `path.resolve` normalises `..` escapes before the comparison.
 */
export function isPathWithinRoots(filePath: string, roots: string[]): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const candidate = path.resolve(filePath);
  for (const root of roots) {
    if (typeof root !== "string" || !root) continue;
    const resolved = path.resolve(root);
    if (candidate === resolved) return true;
    if (candidate.startsWith(resolved + path.sep)) return true;
  }
  return false;
}
