/**
 * Safety interceptor: masks known secret formats before anything is printed.
 * Patterns are intentionally specific to keep false positives low.
 */

import { StringDecoder } from 'node:string_decoder';

interface SecretPattern {
  name: string;
  re: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { name: 'private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  // OpenAI: sk-..., sk-proj-..., sk-svcacct-...
  { name: "openai", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  // Anthropic: sk-ant-...
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  // AWS access key IDs (long-term and temporary)
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g },
  // AWS secret access key when assigned to a recognizable name
  {
    name: "aws-secret",
    re: /(aws_?secret_?access_?key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
  },
  // GitHub tokens: classic (ghp_, gho_, ghu_, ghs_, ghr_) and fine-grained
  { name: "github", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
];

function maskToken(token: string): string {
  // Keep a short prefix so the user can tell which key leaked, hide the rest.
  const keep = Math.min(4, Math.floor(token.length / 6));
  return `${token.slice(0, keep)}****[REDACTED]`;
}

export function sanitize(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) {
    if (name === "aws-secret") {
      out = out.replace(re, (_m, prefix: string) => `${prefix}****[REDACTED]`);
    } else {
      out = out.replace(re, (m) => maskToken(m));
    }
  }
  out = out.replace(/(authorization\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;]+/gi, '$1****[REDACTED]');
  return out.replace(/((?:api[_-]?key|password|passwd|secret|access[_-]?token|authorization)\s*["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_match, prefix: string) => `${prefix}****[REDACTED]`);
}

/** Buffer complete lines before disclosure, preserving UTF-8 boundaries.
 * Oversized/incomplete lines fail closed instead of flushing an unclassified prefix.
 */
export class StreamRedactor {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private overflow = false;
  private privateKey = false;

  write(chunk: string | Uint8Array): string {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(Buffer.from(chunk));
    let output = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.overflow) this.pending += part;
      if (this.pending.length > 65536) {
        if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(this.pending)) this.privateKey = true;
        this.pending = '';
        this.overflow = true;
        output += '****[REDACTED oversized output]';
      }
      if (part.endsWith('\n')) {
        if (this.overflow) output += '\n';
        else output += this.line(this.pending);
        this.pending = '';
        this.overflow = false;
      }
    }
    return output;
  }

  private line(value: string): string {
    if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(value)) this.privateKey = true;
    if (this.privateKey) {
      if (/-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(value)) this.privateKey = false;
      return '****[REDACTED]\n';
    }
    return sanitize(value);
  }

  end(): string {
    const tail = this.decoder.end();
    const output = this.write(tail);
    const remaining = this.pending;
    this.pending = '';
    return output + (this.overflow || !remaining ? '' : this.line(remaining));
  }

  cancel(): void {
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
    this.overflow = false;
    this.privateKey = false;
  }
}

/** Returns the names of secret types found, without exposing the values. */
export function detectSecretTypes(text: string): string[] {
  const found: string[] = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(name);
    re.lastIndex = 0;
  }
  return found;
}

/** Monkey-patches process.stdout/stderr so nothing leaves the process unmasked. */
const cancellations: Array<() => void> = [];
export function cancelSanitizedStreams(): void { cancellations.forEach(cancel => cancel()); }

export function installSanitizedStreams(): void {
  const flushers: Array<() => void> = [];
  for (const stream of [process.stdout, process.stderr]) {
    const redactor = new StreamRedactor();
    cancellations.push(() => redactor.cancel());
    const original = stream.write.bind(stream) as (...args: any[]) => boolean;
    flushers.push(() => { const tail = redactor.end(); if (tail) original(tail); });
    stream.write = ((chunk: any, ...rest: any[]) => {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        const output = redactor.write(chunk);
        if (output) return original(output, ...rest);
        const callback = rest.find(value => typeof value === 'function');
        if (callback) queueMicrotask(callback);
        return true;
      }
      return original(chunk, ...rest);
    }) as typeof stream.write;
  }
  const flush = () => flushers.forEach(flusher => flusher());
  process.on('beforeExit', flush);
  const exit = process.exit.bind(process);
  process.exit = ((code) => { flush(); return exit(code); }) as typeof process.exit;
}
