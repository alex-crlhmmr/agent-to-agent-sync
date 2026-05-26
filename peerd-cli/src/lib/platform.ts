// Cross-platform helpers shared by `peerd init` and friends.

import * as fs from "node:fs";
import * as path from "node:path";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

/**
 * Resolve a command name to an absolute path by scanning PATH.
 * Works on Windows (honors PATHEXT, .exe/.cmd/.bat) and Unix.
 *
 * Pure-Node so it does not depend on the `which` binary (absent on Windows)
 * or the `where.exe` shim. Returns null if not found.
 */
export function whichSync(cmd: string): string | null {
  const exts = IS_WIN
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
    : [""];
  const sep = IS_WIN ? ";" : ":";
  const dirs = (process.env.PATH ?? "").split(sep);

  // If `cmd` already has a path separator or extension, only try it directly.
  const hasExt = path.extname(cmd) !== "";
  const tryExts = hasExt ? [""] : exts;

  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of tryExts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * Try to symlink src → dst. On EPERM (typical Windows-without-Developer-Mode),
 * fall back to a recursive copy. Returns the strategy actually used so the
 * caller can warn the user about copy-mode caveats (skill edits won't propagate
 * without re-init).
 */
export function symlinkOrCopyDir(src: string, dst: string): "symlink" | "copy" {
  try {
    fs.symlinkSync(src, dst, "dir");
    return "symlink";
  } catch (e: any) {
    if (e?.code !== "EPERM" && e?.code !== "EACCES" && e?.code !== "ENOTSUP") throw e;
    // Junctions are another option on Windows but require admin too in some
    // configurations; recursive copy is the most portable fallback.
    fs.cpSync(src, dst, { recursive: true, force: false });
    return "copy";
  }
}
