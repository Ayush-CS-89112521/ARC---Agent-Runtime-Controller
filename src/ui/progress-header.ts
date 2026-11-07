/**
 * ProgressHeader - Displays workflow progress with ETA calculation
 * Shows step counter, progress bar, elapsed time, and estimated time remaining
 */

import { TerminalUI } from './terminal-ui.js';

/**
 * Progress state
 */
interface ProgressState {
  currentStep: number;
  totalSteps: number;
  currentStepId: string;
  startTime: Date;
  completedSteps: string[];
  skippedSteps: string[];
}

/**
 * Displays and updates workflow progress header
 */
export class ProgressHeader {
  private state: ProgressState;
  private lastRenderedTime: number = 0;
  private renderInterval: number = 500; // Update every 500ms
  private isEnabled: boolean;

  constructor(totalSteps: number, isEnabled: boolean = true) {
    this.isEnabled = isEnabled;
    this.state = {
      currentStep: 0,
      totalSteps,
      currentStepId: '',
      startTime: new Date(),
      completedSteps: [],
      skippedSteps: [],
    };
  }

  /**
   * Update progress state and render if interval has passed
   * @param currentStep - Current step number (1-based)
   * @param stepId - ID of current step
   * @param completedSteps - Array of completed step IDs
   * @param skippedSteps - Array of skipped step IDs
   */
  public update(
    currentStep: number,
    stepId: string,
    completedSteps?: string[],
    skippedSteps?: string[]
  ): void {
    if (!this.isEnabled) return;

    this.state.currentStep = currentStep;
    this.state.currentStepId = stepId;

    if (completedSteps) this.state.completedSteps = completedSteps;
    if (skippedSteps) this.state.skippedSteps = skippedSteps;

    // Only render if interval has passed (prevent flicker)
    const now = Date.now();
    if (now - this.lastRenderedTime > this.renderInterval) {
      this.render();
      this.lastRenderedTime = now;
    }
  }

  /**
   * Force render immediately (useful for final status)
   */
  public forceRender(): void {
    if (!this.isEnabled) return;
    this.render();
  }

  /**
   * Get elapsed time since workflow start
   */
  public getElapsedMs(): number {
    return Date.now() - this.state.startTime.getTime();
  }

  /**
   * Render progress header to console
   */
  private render(): void {
    const { currentStep, totalSteps, currentStepId, startTime, completedSteps, skippedSteps } =
      this.state;

    const elapsed = Date.now() - startTime.getTime();
    const lines: string[] = [];

    // Title bar
    lines.push(TerminalUI.colors.highlight('▶ Agent Runtime Controller'));

    // Progress bar and counter
    lines.push(
      TerminalUI.progress.bar(currentStep, totalSteps, 40) +
        '  ' +
        TerminalUI.progress.counter(currentStep, totalSteps)
    );

    // Current step
    lines.push(`Current:  ${TerminalUI.colors.info(currentStepId)}`);

    // Timing info
    lines.push(
      `Elapsed:  ${this.formatDuration(elapsed)} | ` +
        TerminalUI.progress.eta(elapsed, currentStep, totalSteps)
    );

    // Summary of completed/skipped
    const summary = [];
    if (completedSteps.length > 0) {
      summary.push(TerminalUI.colors.success(`${completedSteps.length} completed`));
    }
    if (skippedSteps.length > 0) {
      summary.push(TerminalUI.colors.subtle(`${skippedSteps.length} skipped`));
    }

    if (summary.length > 0) {
      lines.push(`Summary:  ${summary.join(' | ')}`);
    }

    // Separator
    lines.push(TerminalUI.frame.separator(80));

    // Clear and render (only if interactive)
    if (process.stdout.isTTY) {
      console.clear();
    }
    console.log(lines.join('\n'));
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${secs}s`;
    } else {
      return `${secs}s`;
    }
  }
}
