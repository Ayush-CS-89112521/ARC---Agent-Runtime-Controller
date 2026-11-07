
import { describe, it, expect, beforeEach, afterEach, spyOn, mock, beforeAll } from 'bun:test';
import { SafetyViolation } from '../../src/types/index';
import { ToolDescriptor } from '../../src/types/tool-discovery';

mock.module('../../src/interactive/editor-process.js', () => ({ launchEditor: async () => {} }));

// Mock console to keep output clean
const logSpy = spyOn(console, 'log').mockImplementation(() => { });
const clearSpy = spyOn(console, 'clear').mockImplementation(() => { });

// Mock inquirer BEFORE importing the module under test
mock.module('inquirer', () => ({
    default: {
        prompt: async () => ({ decision: 'deny' })
    }
}));

describe('Prompt Handler', () => {
    let promptHandler: any;

    beforeAll(async () => {
        // Dynamic import to ensure mock is applied
        promptHandler = await import('../../src/interactive/prompt-handler');
    });

    describe('Stateless Logic', () => {
        it('should parse user input correctly', () => {
            const { parseUserInput } = promptHandler;
            expect(parseUserInput('a')).toBe('allow');
            expect(parseUserInput('A')).toBe('allow');
            expect(parseUserInput('approve')).toBe('allow');

            expect(parseUserInput('i')).toBe('inspect');
            expect(parseUserInput('d')).toBe('deny');

            expect(parseUserInput('x')).toBeNull();
        });

        it('should determine risk indicator correctly', () => {
            const { getToolRiskIndicator } = promptHandler;
            const officialTool = {
                name: 'test-tool',
                isOfficial: true,
                scope: 'read-only'
            } as any;

            const communityTool = {
                ...officialTool,
                isOfficial: false
            };

            expect(getToolRiskIndicator(officialTool)).toBe('🟢');
            expect(getToolRiskIndicator(communityTool)).toBe('🟡');
            expect(getToolRiskIndicator(undefined)).toBe('🔴');
        });

        it('should format decision summary correctly', () => {
            const { formatDecisionSummary } = promptHandler;
            // Cast to any to bypass strict category type check for test
            const allowSummary = formatDecisionSummary('allow', 'step-1', 'destructive' as any);
            expect(allowSummary).toContain('APPROVED - Variable persisted');
            expect(allowSummary).toContain('step-1');
            expect(allowSummary).toContain('destructive');

            const denySummary = formatDecisionSummary('deny', 'step-1', 'destructive' as any);
            expect(denySummary).toContain('DENIED - Step failed');
        });

        it('should format violation box correctly', () => {
            const { formatViolationBox } = promptHandler;
            const violation: SafetyViolation = {
                category: 'destructive',
                severity: 'block',
                pattern: 'rm -rf',
                match: 'rm -rf /',
                confidence: 0.95,
                line: 10,
                remediation: 'Do not use rm -rf',
                timestamp: new Date()
            } as any;

            const output = formatViolationBox(violation, 'step-1');

            expect(output).toContain('Safety Violation Detected');
            expect(output).toContain('Category:      DESTRUCTIVE');
            expect(output).toContain('Match: "rm -rf /"');
        });

        it('should include tool context in violation box', () => {
            const { formatViolationBox } = promptHandler;
            const violation = {
                category: 'destructive',
                severity: 'pause',
                pattern: 'exec',
                match: 'exec()',
                confidence: 0.8,
                line: 5,
                remediation: 'Check exec',
                timestamp: new Date()
            } as any;

            const tool = {
                name: 'dangerous-tool',
                description: 'desc',
                category: 'sys-ops',
                scope: 'full-control',
                isOfficial: false,
                languages: ['bash'],
                estimatedResourceProfile: { cpu: 'high', memory: 'low' }
            } as any;

            const output = formatViolationBox(violation, 'step-1', tool);

            expect(output).toContain('Safety Violation');
            expect(output).toContain('Tool Context:');
            expect(output).toContain('dangerous-tool');
            expect(output).toContain('sys-ops');
        });
    });

    describe('Environment Detection', () => {
        const originalEnv = { ...process.env };
        const originalIsTTY = process.stdin.isTTY;

        afterEach(() => {
            process.env = originalEnv;
            Object.defineProperty(process.stdin, 'isTTY', {
                value: originalIsTTY,
                configurable: true
            });
        });

        it('should detect non-interactive if stdin is not TTY', () => {
            const { isInteractiveEnvironment } = promptHandler;
            Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
            expect(isInteractiveEnvironment()).toBe(false);
        });

        it('should detect interactive if TTY is true and no CI vars', () => {
            const { isInteractiveEnvironment } = promptHandler;
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
            delete process.env.CI;
            delete process.env.GITHUB_ACTIONS;
            delete process.env.CONTINUOUS_INTEGRATION;
            expect(isInteractiveEnvironment()).toBe(true);
        });
    });

    describe('Interactive Prompts (Native Bun)', () => {
        const originalPrompt = (globalThis as any).prompt;
        const originalEnv = { ...process.env };
        const originalIsTTY = process.stdin.isTTY;

        beforeEach(() => {
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
            delete process.env.CI;
            delete process.env.GITHUB_ACTIONS;
        });

        afterEach(() => {
            (globalThis as any).prompt = originalPrompt;
            process.env = originalEnv;
            Object.defineProperty(process.stdin, 'isTTY', {
                value: originalIsTTY,
                configurable: true
            });
        });

        const mockViolation = {
            category: 'destructive',
            severity: 'pause',
            pattern: 'rm -rf',
            match: 'rm -rf /',
            confidence: 1.0,
            line: 1,
            remediation: 'fix it',
            timestamp: new Date()
        } as any;

        it('should handle "allow" input via native prompt', async () => {
            const { promptForApproval } = promptHandler;
            (globalThis as any).prompt = () => 'a';

            const result = await promptForApproval(mockViolation, 'step-1', 'content');
            expect(result.decision).toBe('allow');
            expect(result.recorded).toBe(true);
        });

        it('should retry on invalid input then deny on max attempts', async () => {
            const { promptForApproval } = promptHandler;
            // Returns invalid, invalid, invalid -> max attempts
            (globalThis as any).prompt = () => 'x';

            const result = await promptForApproval(
                mockViolation,
                'step-1',
                'content'
            );

            expect(result.decision).toBe('deny');
        });

        it('should retry on invalid input and then succeed', async () => {
            const { promptForApproval } = promptHandler;
            let callCount = 0;
            // First returns 'x' (invalid), then 'a' (allow)
            (globalThis as any).prompt = () => {
                callCount++;
                return callCount === 1 ? 'x' : 'a';
            };

            const result = await promptForApproval(mockViolation, 'step-1', 'content');
            expect(result.decision).toBe('allow');
            expect(callCount).toBe(2);
        });

        it('should handle cancellation (null prompt result)', async () => {
            const { promptForApproval } = promptHandler;
            (globalThis as any).prompt = () => null;

            const result = await promptForApproval(mockViolation, 'step-1', 'content');
            expect(result.decision).toBe('deny'); // Cancel defaults to deny
            expect(result.recorded).toBe(true);
        });
    });

    describe('Interactive Prompts (Inquirer)', () => {
        let inquirerMock: any;

        beforeAll(async () => {
            inquirerMock = await import('inquirer');
        });

        beforeEach(() => {
            Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
            delete process.env.CI;
        });

        it('should handle "allow" decision from Inquirer', async () => {
            const { promptForApprovalWithInquirer } = promptHandler;

            const spy = spyOn(inquirerMock.default, 'prompt').mockResolvedValue({ decision: 'allow' });

            const result = await promptForApprovalWithInquirer(
                { category: 'destructive', severity: 'pause', confidence: 1 } as any,
                'step-1',
                'content'
            );
            expect(result.decision).toBe('allow');
            expect(result.recorded).toBe(true);

            spy.mockRestore();
        });

        it('should return denied decision by default mock', async () => {
            const { promptForApprovalWithInquirer } = promptHandler;

            const spy = spyOn(inquirerMock.default, 'prompt').mockResolvedValue({ decision: 'deny' });

            const result = await promptForApprovalWithInquirer(
                { category: 'destructive', severity: 'pause', confidence: 1 } as any,
                'step-1',
                'content'
            );
            expect(result.decision).toBe('deny');

            spy.mockRestore();
        });

        it('should handle "inspect" then "allow"', async () => {
            const { promptForApprovalWithInquirer } = promptHandler;

            // Set EDITOR to 'true' to exit immediately without hanging
            process.env.EDITOR = 'true';

            // Let's assume spy sequence: first call inspect, second call allow.
            // Note: because openInEditor is async and calls spawn, using 'true' makes it fast.
            const promptSpy = spyOn(inquirerMock.default, 'prompt')
                .mockResolvedValueOnce({ decision: 'inspect' })
                .mockResolvedValueOnce({ decision: 'allow' });

            const result = await promptForApprovalWithInquirer(
                { category: 'destructive', severity: 'pause', confidence: 1 } as any,
                'step-1',
                'content'
            );
            expect(result.decision).toBe('allow');
            expect(result.recorded).toBe(true);

            // Should be called twice (inspect -> allow)
            expect(promptSpy).toHaveBeenCalledTimes(2);

            promptSpy.mockRestore();
        });

        it('should handle remediation approval', async () => {
            const { promptForRemediationApproval } = promptHandler;

            // Inquirer "confirm" prompt
            const spy = spyOn(inquirerMock.default, 'prompt').mockResolvedValue({ approve: true });

            const result = await promptForRemediationApproval('step-1', 'fix', 'content');
            expect(result).toBe(true);

            spy.mockRestore();
        });

        it('should handle remediation rejection', async () => {
            const { promptForRemediationApproval } = promptHandler;

            const spy = spyOn(inquirerMock.default, 'prompt').mockResolvedValue({ approve: false });

            const result = await promptForRemediationApproval('step-1', 'fix', 'content');
            expect(result).toBe(false);

            spy.mockRestore();
        });
    });

    describe('Environment Detection & Fallbacks', () => {
        let inquirerMock: any;
        const originalEnv = { ...process.env };
        const originalIsTTY = process.stdin.isTTY;

        beforeAll(async () => {
            inquirerMock = await import('inquirer');
        });

        afterEach(() => {
            process.env = originalEnv;
            Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
        });

        it('should auto-deny in non-interactive environment (promptForApproval)', async () => {
            const { promptForApproval } = promptHandler;
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

            const result = await promptForApproval({ severity: 'block' } as any, 'step-1', 'content');
            expect(result.decision).toBe('deny');
        });

        it('should auto-deny in non-interactive environment (Inquirer)', async () => {
            const { promptForApprovalWithInquirer } = promptHandler;
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

            const result = await promptForApprovalWithInquirer({ severity: 'block' } as any, 'step-1', 'content');
            expect(result.decision).toBe('deny');
        });

        it('should skip remediation prompt in non-interactive environment', async () => {
            const { promptForRemediationApproval } = promptHandler;
            Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

            const result = await promptForRemediationApproval('step-1', 'fix');
            expect(result).toBe(false);
        });
    });
});
