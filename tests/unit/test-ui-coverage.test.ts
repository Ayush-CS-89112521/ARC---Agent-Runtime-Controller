import { describe, it, expect, mock, spyOn, afterAll, beforeEach } from 'bun:test';
import { SpinnerManager } from '../../src/ui/spinner-manager';
import { ProgressHeader } from '../../src/ui/progress-header';

// Mock ora
const mockOraInstance = {
    start: mock(() => mockOraInstance),
    stop: mock(() => mockOraInstance),
    succeed: mock(() => mockOraInstance),
    fail: mock(() => mockOraInstance),
    warn: mock(() => mockOraInstance),
    text: ''
};

mock.module('ora', () => {
    return {
        default: () => mockOraInstance
    };
});

describe('UI Coverage Boost', () => {

    describe('SpinnerManager', () => {
        let spinner: SpinnerManager;

        beforeEach(() => {
            spinner = new SpinnerManager(true);
            mockOraInstance.start.mockClear();
            mockOraInstance.stop.mockClear();
            mockOraInstance.succeed.mockClear();
            mockOraInstance.fail.mockClear();
            mockOraInstance.warn.mockClear();
        });

        it('should start a spinner', () => {
            spinner.start('step-1', 'agent-1');
            expect(mockOraInstance.start).toHaveBeenCalled();
            expect(spinner.isRunning()).toBe(true);
        });

        it('should update spinner text', () => {
            spinner.start('step-1', 'agent-1');
            spinner.update('processing...');
            // verify state is updated
            expect(spinner.getState().details).toBe('processing...');
        });

        it('should succeed a step', () => {
            spinner.start('step-1');
            spinner.succeed('done');
            expect(mockOraInstance.succeed).toHaveBeenCalled();
            expect(spinner.isRunning()).toBe(false); // isRunning checks if status is running
            expect(spinner.getState().status).toBe('success');
        });

        it('should fail a step', () => {
            spinner.start('step-1');
            spinner.fail('error');
            expect(mockOraInstance.fail).toHaveBeenCalled();
            expect(spinner.getState().status).toBe('failed');
        });

        it('should skip a step', () => {
            spinner.start('step-1');
            spinner.skip('reason');
            expect(mockOraInstance.warn).toHaveBeenCalled();
            expect(spinner.getState().status).toBe('skipped');
        });

        it('should alert', () => {
            spinner.start('step-1');
            spinner.alert('alert!');
            expect(mockOraInstance.warn).toHaveBeenCalled();
            expect(spinner.getState().status).toBe('alert');
        });

        it('should handle disabled state', () => {
            const disabledSpinner = new SpinnerManager(false);
            disabledSpinner.start('step-1');
            expect(mockOraInstance.start).not.toHaveBeenCalled();
        });
    });

    describe('ProgressHeader', () => {
        // Mock console.log/clear
        const logSpy = spyOn(console, 'log').mockImplementation(() => { });
        const clearSpy = spyOn(console, 'clear').mockImplementation(() => { });

        beforeEach(() => {
            // No cleanup needed actually since we mockImplementation
        });

        afterAll(() => {
            logSpy.mockRestore();
            clearSpy.mockRestore();
        });

        it('should render progress', () => {
            const header = new ProgressHeader(10, true);
            header.update(1, 'step-1');
            // Force render since update has throttle
            header.forceRender();

            expect(logSpy).toHaveBeenCalled();
            const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
            // Since we mocked console.log, arguments are passed. 
            // In Bun test, mock.calls gives arguments array.
            // console.log receives a string.
            expect(lastCall).toContain('Agent Runtime Controller');
            expect(lastCall).toContain('Current:');
        });

        it('should update state correctly', () => {
            const header = new ProgressHeader(10, true);
            // Casting string[] to any because of potential type mismatch in mock call verification if precise usage needed
            // But here looking at side effects
            header.update(5, 'step-5', ['1', '2', '3', '4'], []);
            header.forceRender();
            const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1][0];
            expect(lastCall).toContain('4 completed');
        });

        it('should not render if disabled', () => {
            logSpy.mockClear();
            const header = new ProgressHeader(10, false);
            header.forceRender();
            expect(logSpy).not.toHaveBeenCalled();
        });
    });
});
