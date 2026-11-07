import { SPINNER_FRAMES, formatRow, type Row } from './format.js';
import { ESC, SYNC_END, SYNC_START, columns, hideCursor, showCursor, truncateAnsi } from './term.js';

/**
 * Live step list. Every frame is ONE stdout.write, lines are overwritten in
 * place (never blanked first) and wrapped in synchronized-output markers,
 * so there is no flicker even at 12.5 fps.
 */
export class Block {
  private height = 0;
  private tick = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly rows: Row[],
    private readonly width: number,
  ) {}

  start(): void {
    hideCursor();
    this.resume();
  }

  /** Start (or restart) the spinner animation. */
  resume(): void {
    this.draw();
    this.timer ??= setInterval(() => {
      this.tick++;
      this.draw();
    }, 80);
  }

  /** Freeze the animation, e.g. while a prompt owns the cursor. */
  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stop(): void {
    this.pause();
    this.draw();
    showCursor();
  }

  /** Remove `lines` lines printed below the block (prompt + box) and put the cursor back under it. */
  erase(lines: number): void {
    process.stdout.write(`${ESC}${lines}A\r${ESC}0J`);
  }

  draw(): void {
    const frame = SPINNER_FRAMES[this.tick % SPINNER_FRAMES.length]!;
    const max = columns() - 1; // never wrap: wrapping would break the line count
    const lines = this.rows.flatMap((r) => formatRow(r, frame, this.width)).map((l) => truncateAnsi(l, max));

    let out = SYNC_START;
    if (this.height > 0) out += `${ESC}${this.height}A`;
    out += lines.map((l) => `\r${ESC}2K${l}\n`).join('');
    out += `${ESC}0J${SYNC_END}`; // clear leftovers if the block shrank
    process.stdout.write(out);
    this.height = lines.length;
  }
}
