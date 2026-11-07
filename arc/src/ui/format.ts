import pc from 'picocolors';

export type StepStatus = 'pending' | 'running' | 'success' | 'warning' | 'failed';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const SYMBOLS = {
  pending: '○',
  success: '✔',
  warning: '⚠',
  failed: '✖',
} as const;

export interface Row {
  title: string;
  status: StepStatus;
  /** Elapsed milliseconds, set once the step finishes. */
  ms?: number;
  /** Extra lines under the step (already colored). Rendered with a tree connector. */
  details: string[];
}

export const formatMs = (ms: number): string => `${Math.round(ms)}ms`;

/** Word-wrap plain text (no ANSI) so long messages never get cut off. Color each line after wrapping. */
export function wrap(text: string, width: number): string[] {
  const max = Math.max(20, width);
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [''];
}

/** Pure function: one step -> one or more terminal lines. */
export function formatRow(row: Row, frame: string, width: number): string[] {
  const title = row.title.padEnd(width);
  const time = row.ms === undefined ? '' : `  ${pc.dim(formatMs(row.ms))}`;

  let head: string;
  switch (row.status) {
    case 'pending':
      head = `${pc.dim(SYMBOLS.pending)} ${pc.dim(row.title)}`;
      break;
    case 'running':
      head = `${pc.cyan(frame)} ${title}`;
      break;
    case 'success':
      head = `${pc.green(SYMBOLS.success)} ${title}${time}`;
      break;
    case 'warning':
      head = `${pc.yellow(SYMBOLS.warning)} ${pc.yellow(title)}${time}`;
      break;
    case 'failed':
      head = `${pc.red(SYMBOLS.failed)} ${pc.red(title)}${time}`;
      break;
  }

  const tint = row.status === 'failed' ? pc.red : row.status === 'warning' ? pc.yellow : pc.dim;
  const last = row.details.length - 1;
  const details = row.details.map((d, i) => `  ${tint(i === last ? '╰' : '│')} ${d}`);

  return [head, ...details];
}
