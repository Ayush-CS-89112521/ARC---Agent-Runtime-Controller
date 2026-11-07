import pc from 'picocolors';
import { columns, truncateAnsi, visibleLength } from './term.js';

export interface BoxOptions {
  /** Optional label set into the top border. May contain ANSI colors. */
  title?: string;
  /** Content lines. May contain ANSI colors. */
  lines: string[];
  /** Colors the border. Default: dim. */
  color?: (s: string) => string;
  /** Left indent in spaces. */
  indent?: number;
}

/** Compact rounded box. Returns lines (not a string) so callers can count them. */
export function box({ title, lines, color = pc.dim, indent = 0 }: BoxOptions): string[] {
  const pad = ' '.repeat(indent);
  const maxInner = Math.max(24, columns() - indent - 5);

  const label = title ? truncateAnsi(title, maxInner - 1) : '';
  const labelLen = visibleLength(label);
  const body = lines.map((l) => truncateAnsi(l, maxInner));
  const inner = Math.max(labelLen ? labelLen + 1 : 0, 1, ...body.map(visibleLength));

  const top = label
    ? `${color('╭─')} ${label} ${color(`${'─'.repeat(inner - labelLen - 1)}╮`)}`
    : color(`╭${'─'.repeat(inner + 2)}╮`);
  const side = color('│');
  const rows = body.map((l) => `${side} ${l}${' '.repeat(inner - visibleLength(l))} ${side}`);
  const bottom = color(`╰${'─'.repeat(inner + 2)}╯`);

  return [top, ...rows, bottom].map((l) => pad + l);
}
