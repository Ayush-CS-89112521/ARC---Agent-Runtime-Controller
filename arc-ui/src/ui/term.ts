/** Low-level terminal helpers: ANSI codes, width math, cursor safety. */

export const ESC = '\x1b[';

/** Synchronized output: supporting terminals paint each frame atomically (zero flicker). Others ignore it. */
export const SYNC_START = `${ESC}?2026h`;
export const SYNC_END = `${ESC}?2026l`;

export const columns = (): number => process.stdout.columns || 80;

/** True only in a real, interactive terminal. Pipes, CI logs and TERM=dumb get plain linear output. */
export const canAnimate = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.CI && process.env.TERM !== 'dumb';

const ANSI_GLOBAL = /\x1b\[[0-9;?]*[A-Za-z]/g;

export const stripAnsi = (s: string): string => s.replace(ANSI_GLOBAL, '');
export const visibleLength = (s: string): number => Array.from(stripAnsi(s)).length;

/** Truncate to `max` visible characters without cutting through an ANSI sequence. */
export function truncateAnsi(s: string, max: number): string {
  if (visibleLength(s) <= max) return s;
  const ansi = /\x1b\[[0-9;?]*[A-Za-z]/y;
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < max - 1) {
    ansi.lastIndex = i;
    const m = ansi.exec(s);
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    seen++;
  }
  return `${out}…${ESC}0m`;
}

let guarded = false;

export function showCursor(): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}?25h`);
}

/** Hides the cursor and guarantees it comes back, even on Ctrl+C or a crash. */
export function hideCursor(): void {
  if (!process.stdout.isTTY) return;
  if (!guarded) {
    guarded = true;
    process.on('exit', showCursor);
    process.on('SIGINT', () => {
      showCursor();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      showCursor();
      process.exit(143);
    });
  }
  process.stdout.write(`${ESC}?25l`);
}
