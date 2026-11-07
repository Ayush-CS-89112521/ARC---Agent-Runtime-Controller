import pc from 'picocolors';
import { Block } from './block.js';
import { box } from './box.js';
import { confirm } from './confirm.js';
import { SYMBOLS, formatMs, formatRow, wrap, type Row } from './format.js';
import { canAnimate, columns } from './term.js';

export type Risk = 'low' | 'high';

export interface StepResult {
  /** Finish the step with a yellow warning instead of a green tick. */
  warning?: string;
}

export interface Tool {
  title: string;
  /** Exact commands. Shown in the dry-run diff box and the high-risk guardrail box. */
  commands: string[];
  /** 'high' pauses for a [y/N] confirmation (default answer: No). */
  risk?: Risk;
  run: () => Promise<StepResult | void>;
  /** Plain-English fix shown when the step fails. */
  suggest?: string | ((err: Error) => string);
}

export interface ReporterOptions {
  version: string;
  /** Print what would run; execute nothing. */
  dryRun?: boolean;
  /** Pre-approve high-risk steps (for CI). */
  yes?: boolean;
}

export interface Summary {
  total: number;
  completed: number;
  warned: number;
  failed: number;
  aborted: boolean;
  ms: number;
}

const write = (s: string): void => void process.stdout.write(s);

/** Wrap a message to the terminal width, then color each line. Used for every detail under a step. */
const lines = (text: string, style: (s: string) => string): string[] =>
  wrap(text, columns() - 6).map(style);

/** Turn common Node errors into something a human can act on. */
function explain(err: Error & { code?: string }): string {
  switch (err.code) {
    case 'ENOENT':
      return "A file or command wasn't found. Check the path and make sure the tool is installed.";
    case 'EACCES':
    case 'EPERM':
      return 'Permission was denied. Check file permissions or re-run with the right access.';
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
      return 'The network request failed. Check your connection and try again.';
    default:
      return 'Read the error above, fix the cause, then re-run the command.';
  }
}

export class Reporter {
  constructor(private readonly o: ReporterOptions) {}

  /** One-line branding: name, version, mode. */
  banner(): void {
    const badge = pc.bgCyan(pc.black(pc.bold(' ARC ')));
    const mode = this.o.dryRun ? pc.yellow('dry-run') : pc.green('live');
    write(
      `\n${badge}  ${pc.bold('Agent Runtime Controller')} ${pc.dim(`v${this.o.version}`)} ${pc.dim('·')} ${mode}\n\n`,
    );
  }

  async run(tools: Tool[]): Promise<Summary> {
    const summary: Summary = { total: tools.length, completed: 0, warned: 0, failed: 0, aborted: false, ms: 0 };
    const t0 = performance.now();

    if (this.o.dryRun) {
      this.plan(tools);
      summary.ms = performance.now() - t0;
      return summary;
    }

    const width = Math.max(0, ...tools.map((t) => t.title.length));
    const rows: Row[] = tools.map((t) => ({ title: t.title, status: 'pending', details: [] }));

    // Fall back to linear output when piped, in CI, or when the list wouldn't fit on screen.
    const fits = tools.length < (process.stdout.rows || 24) - 6;
    const block = canAnimate() && fits ? new Block(rows, width) : undefined;
    block?.start();

    const emit = (i: number): void => {
      if (!block) write(formatRow(rows[i]!, '', width).join('\n') + '\n');
    };

    try {
      for (let i = 0; i < tools.length; i++) {
        const tool = tools[i]!;
        const row = rows[i]!;

        if (tool.risk === 'high' && !(await this.guard(tool, row, block))) {
          summary.aborted = true;
          emit(i);
          break;
        }

        row.status = 'running';
        block?.draw();
        const started = performance.now();

        try {
          const result = await tool.run();
          row.ms = performance.now() - started;
          summary.completed++;
          if (result && result.warning) {
            row.status = 'warning';
            row.details.push(...lines(result.warning, pc.yellow));
            summary.warned++;
          } else {
            row.status = 'success';
          }
          block?.draw();
          emit(i);
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          const tip = typeof tool.suggest === 'function' ? tool.suggest(err) : (tool.suggest ?? explain(err));
          row.ms = performance.now() - started;
          row.status = 'failed';
          row.details.push(...lines(err.message.split('\n')[0] ?? 'Unknown error', pc.dim));
          const [first = '', ...rest] = lines(`Suggestion: ${tip}`, (l) => l);
          row.details.push(first.replace('Suggestion:', pc.bold('Suggestion:')), ...rest);
          summary.failed++;
          block?.draw();
          emit(i);
          break;
        }
      }
    } finally {
      block?.stop();
    }

    summary.ms = performance.now() - t0;
    this.summarize(summary);
    return summary;
  }

  /** Dry-run: every step with a compact diff box of the exact commands. Nothing executes. */
  private plan(tools: Tool[]): void {
    for (const t of tools) {
      const high = t.risk === 'high';
      write(
        high
          ? `${pc.yellow(SYMBOLS.warning)} ${pc.yellow(t.title)} ${pc.dim('· high risk · would ask you to confirm')}\n`
          : `${pc.dim(SYMBOLS.pending)} ${t.title}\n`,
      );
      const card = box({
        title: pc.dim('would run'),
        lines: t.commands.map((c) => `${pc.green('+')} ${c}`),
        color: high ? pc.yellow : pc.dim,
        indent: 2,
      });
      write(card.join('\n') + '\n');
    }
    write(
      `\n${pc.dim(SYMBOLS.pending)} ${pc.bold('Dry run complete')} ${pc.dim(`· ${tools.length} steps planned · nothing was executed`)}\n`,
    );
    write(pc.dim('  Re-run without --dry-run to apply.\n'));
  }

  /** High-risk guardrail. Returns true only on an explicit "y". */
  private async guard(tool: Tool, row: Row, block: Block | undefined): Promise<boolean> {
    if (this.o.yes) {
      row.details.push(...lines('high-risk step · auto-approved with --yes', pc.yellow));
      return true;
    }

    row.status = 'warning';

    if (!process.stdin.isTTY) {
      row.details.push(...lines('high-risk step needs confirmation · run in a terminal or pass --yes', pc.yellow));
      block?.draw();
      return false;
    }

    block?.draw();
    block?.pause(); // the prompt owns the cursor now

    const card = box({
      title: pc.yellow(`${SYMBOLS.warning} High-risk step`),
      color: pc.yellow,
      lines: [pc.bold(tool.title), ...tool.commands.map((c) => `${pc.dim('$')} ${c}`)],
    });
    write(card.join('\n') + '\n');

    const approved = await confirm(`${pc.yellow('?')} Run this step? ${pc.dim('[y/N]')} `);

    block?.erase(card.length + 1); // box + prompt line, so the list redraws cleanly

    if (approved) {
      row.status = 'running';
      row.details = lines('high-risk step · approved by you', pc.yellow);
      block?.resume();
    } else {
      row.details = lines('aborted by you · nothing was changed', pc.yellow);
    }
    return approved;
  }

  private summarize(s: Summary): void {
    const stats = `${s.completed} of ${s.total} steps`;
    const time = formatMs(s.ms);
    let line: string;
    if (s.failed > 0) {
      line = `${pc.red(SYMBOLS.failed)} ${pc.bold('Failed')} ${pc.dim(`· ${stats} completed · ${time}`)}`;
    } else if (s.aborted) {
      line = `${pc.yellow(SYMBOLS.warning)} ${pc.bold('Aborted')} ${pc.dim(`· ${stats} completed · ${time}`)}`;
    } else {
      const warn = s.warned > 0 ? ` · ${s.warned} ${s.warned === 1 ? 'warning' : 'warnings'}` : '';
      line = `${pc.green(SYMBOLS.success)} ${pc.bold('Done')} ${pc.dim(`· ${s.total} steps${warn} · ${time}`)}`;
    }
    write(`\n${line}\n\n`);
  }
}
