import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as fs from 'fs';

// Mock Inquirer
const mockPrompt = mock((_args?: any) => {
    return Promise.resolve({ action: 'run', feedback: 'test-feedback', resolution: 'halt' });
});

mock.module('inquirer', () => {
    return {
        default: {
            prompt: mockPrompt
        }
    };
});

// Mock Bun.spawn
const mockSpawn = mock((_args?: any) => {
    return {
        exited: Promise.resolve(0)
    };
});

mock.module('../../src/interactive/editor-process.js', () => {
    return {
        launchEditor: async (editor: string, file: string) => { await mockSpawn([editor, file]).exited; }
    };
});

// Mock fs
const mockReadFileSync = mock((_path: any, _opts: any) => 'modified-args');
mock.module('fs', () => {
    return {
        writeFileSync: mock(() => { }),
        readFileSync: mockReadFileSync,
        unlinkSync: mock(() => { }),
    };
});

// Set editor to something that exists on all systems
process.env.EDITOR = 'true';

// Import AFTER mocks
import {
    presentSteeringPrompt,
    editArgumentsInteractively,
    promptForLoopResolution,
    WorkflowTerminatedByUser
} from '../../src/interactive/steering-handler';

describe('SteeringHandler', () => {
    const sampleContext = {
        stepId: '1',
        toolName: 'test-tool',
        args: '{"a": 1}',
        reasoning: 'Testing steering'
    };

    beforeEach(() => {
        mockPrompt.mockReset();
        mockSpawn.mockReset();
        mockReadFileSync.mockReset();
        mockReadFileSync.mockReturnValue('modified-args');
        // Default mock behavior for spawn
        mockSpawn.mockReturnValue({ exited: Promise.resolve(0) } as any);
    });

    describe('presentSteeringPrompt', () => {
        it('should return run action', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'run' } as any);
            const result = await presentSteeringPrompt(sampleContext);
            expect(result.action).toBe('run');
        });

        it('should return terminate action', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'terminate' } as any);
            const result = await presentSteeringPrompt(sampleContext);
            expect(result.action).toBe('terminate');
        });

        it('should return add-context with feedback', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'add-context' } as any);
            mockPrompt.mockResolvedValueOnce({ feedback: 'test-feedback' } as any);
            const result = await presentSteeringPrompt(sampleContext);
            expect(result.action).toBe('add-context');
            expect(result.feedback).toBe('test-feedback');
        });

        it('should return edit action with modified args', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'edit' } as any);
            const result = await presentSteeringPrompt(sampleContext);
            expect(result.action).toBe('edit');
            expect(result.modifiedArgs).toBe('modified-args');
        });

        it('should throw error for unknown action', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'unknown' } as any);
            await expect(presentSteeringPrompt(sampleContext)).rejects.toThrow('Unknown steering action: unknown');
        });
    });

    describe('editArgumentsInteractively', () => {
        it('should write to temp file, spawn editor, and read back', async () => {
            const result = await editArgumentsInteractively('original');
            expect(result).toBe('modified-args');
        });

        it('should log when no changes are made', async () => {
            mockReadFileSync.mockReturnValueOnce('original');
            const result = await editArgumentsInteractively('original');
            expect(result).toBe('original');
        });
    });

    describe('promptForLoopResolution', () => {
        it('should return selected resolution', async () => {
            mockPrompt.mockResolvedValueOnce({ resolution: 'modify' } as any);
            const res = await promptForLoopResolution({
                stepId: 'loop1',
                toolName: 'toolA',
                recentInvocations: [{ tool: 'toolA', args: '{}' }]
            });
            expect(res).toBe('modify');
        });
    });

    describe('Inquirer Validation', () => {
        it('should validate feedback length', async () => {
            mockPrompt.mockResolvedValueOnce({ action: 'add-context' } as any);

            // Second prompt call is in promptForContextFeedback
            mockPrompt.mockImplementationOnce(((args: any) => {
                const validate = args[0].validate;
                expect(validate('')).toBe('Please provide feedback');
                expect(validate('some feedback')).toBe(true);
                return Promise.resolve({ feedback: 'valid' });
            }) as any);

            await presentSteeringPrompt(sampleContext);
        });
    });

    describe('WorkflowTerminatedByUser', () => {
        it('should be an instance of Error', () => {
            const err = new WorkflowTerminatedByUser('stopped');
            expect(err).toBeInstanceOf(Error);
            expect(err.name).toBe('WorkflowTerminatedByUser');
        });
    });
});
