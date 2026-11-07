
import { describe, it, expect } from 'bun:test';
import { TerminalUI } from '../../src/ui/terminal-ui';
import chalk from 'chalk';

describe('TerminalUI', () => {
    describe('Text Helpers', () => {
        it('should format success messages', () => {
            const result = TerminalUI.text.success('Done');
            expect(result).toContain('✓ Done');
            // Verify color (green) - checking ANSI codes is brittle, trust chalk logic or check partial string
        });

        it('should format error messages', () => {
            const result = TerminalUI.text.error('Failed');
            expect(result).toContain('✗ Failed');
        });

        it('should format warning messages', () => {
            const result = TerminalUI.text.warning('Caution');
            expect(result).toContain('⚠ Caution');
        });

        it('should format info messages', () => {
            const result = TerminalUI.text.info('Info');
            expect(result).toContain('ℹ Info');
        });

        it('should format subtle messages', () => {
            const result = TerminalUI.text.subtle('details');
            expect(result).toContain('details');
        });

        it('should format highlight messages', () => {
            const result = TerminalUI.text.highlight('important');
            expect(result).toContain('important');
        });
    });

    describe('Frame Helpers', () => {
        it('should create a framed box', () => {
            const content = ['Line 1', 'Line 2'];
            const box = TerminalUI.frame.box(content);

            expect(box).toContain('┌');
            expect(box).toContain('Line 1');
            expect(box).toContain('Line 2');
            expect(box).toContain('└');
        });

        it('should create a framed box with title', () => {
            const content = ['Line 1'];
            const box = TerminalUI.frame.box(content, 'Title');

            expect(box).toContain('Title');
            expect(box).toContain('├');
        });

        it('should create a separator', () => {
            const sep = TerminalUI.frame.separator(10);
            expect(sep.replace(/\x1b\[[0-9;]*m/g, '')).toBe('─'.repeat(10));
        });

        it('should create a header', () => {
            const header = TerminalUI.frame.header('Main Title');
            expect(header).toContain('Main Title');
        });

        it('should create a header with subtitle', () => {
            const header = TerminalUI.frame.header('Main', 'Sub');
            expect(header).toContain('Main');
            expect(header).toContain('Sub');
        });
    });

    describe('Progress Helpers', () => {
        it('should format progress bar', () => {
            const bar = TerminalUI.progress.bar(5, 10, 10);
            // Expect ANSI codes or partial match that ignores them if possible, 
            // but 'toContain' is strict. 
            // Logic: `[${bar}] ${chalk.yellow(percentage.toFixed(0))}%`
            // We can check for the percentage number.
            expect(bar).toMatch(/50.*%/);

            const barFull = TerminalUI.progress.bar(10, 10, 10);
            expect(barFull).toMatch(/100.*%/);
        });

        it('should format step counter', () => {
            const counter = TerminalUI.progress.counter(1, 10);
            expect(counter).toContain('1/10');
        });

        it('should format eta', () => {
            // 0 current -> calculating
            expect(TerminalUI.progress.eta(1000, 0, 10)).toContain('calculating');

            // 500ms elapsed for 1 item, 9 items remaining = 4500ms = 4.5s
            const eta = TerminalUI.progress.eta(500, 1, 10);
            expect(eta).toContain('4.5s');
        });
    });

    describe('Table Helpers', () => {
        it('should format kv pairs', () => {
            const pairs = { 'Key': 'Value', 'LongKey': 'LongValue' };
            const lines = TerminalUI.table.kvPairs(pairs);
            expect(lines.length).toBe(2);
            expect(lines[0]).toContain('Key');
            expect(lines[0]).toContain('Value');
        });

        it('should format columns', () => {
            const rows = [
                { Tool: 'A', Type: 'X' },
                { Tool: 'B', Type: 'Y' }
            ];
            const cols = TerminalUI.table.columns(rows, ['Tool', 'Type']);

            expect(cols[0]).toContain('Tool'); // Header
            expect(cols[0]).toContain('Type');
            expect(cols[2]).toContain('A'); // Data
            expect(cols[2]).toContain('X');
        });
    });
});
