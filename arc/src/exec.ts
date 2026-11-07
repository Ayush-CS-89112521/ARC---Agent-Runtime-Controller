import { execFile } from "node:child_process";
import { sanitize } from "./sanitizer.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary with an argument array (no shell, so no injection).
 * Output is sanitized at the source so secrets never reach callers or logs.
 * Never rejects on non-zero exit; callers inspect `code`.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 5 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : err
              ? 1
              : 0;
        // ENOENT (binary missing) surfaces as a readable stderr instead of a throw.
        const extra = err && (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `${cmd}: command not found`
          : "";
        resolve({
          code,
          stdout: sanitize(String(stdout ?? "")),
          stderr: sanitize(String(stderr ?? "") || extra),
        });
      },
    );
  });
}
