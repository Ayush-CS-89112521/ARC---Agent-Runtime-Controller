/**
 * Resource Watchdog - Monitors child process resource usage
 * Prevents runaway processes (infinite loops, memory leaks, etc.)
 * Differentiates between "AI thinking" and "process stuck" states
 * Persists alerts to disk for audit trail and recovery
 *
 * Layer 4: Tool-aware resource configuration
 * - Auto-tunes CPU/memory limits based on tool language and scope
 * - Adjusts timeouts by tool scope (cloud=2.0x, local=1.0x)
 * - Logs configuration for audit trail
 */

import { spawn } from 'bun';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appendFile } from 'fs/promises';
import { ProcessMetrics, ResourceAlert } from '../types/index.js';
import { getRunDirectory } from '../context/context-manager.js';
import type { ToolDescriptor } from '../types/tool-discovery.js';

/**
 * Configuration for resource watchdog monitoring
 * Supports tool-aware auto-tuning (Layer 4 integration)
 */
export interface WatchdogConfig {
  /** Memory limit in MB (default: 512, auto-tuned by tool language) */
  memoryMB?: number;
  /** CPU warning threshold % (default: 80, auto-tuned by tool language) */
  cpuWarnPercent?: number;
  /** Check interval in milliseconds (default: 500) */
  checkIntervalMs?: number;
  /** Consecutive high-resource readings before kill (default: 6 = 3 seconds at 500ms intervals) */
  maxHighResourceReadings?: number;
  /** Optional run ID for persistent alert storage */
  runId?: string;
  /** Tool descriptor for Layer 4 auto-tuning of resource limits */
  tool?: ToolDescriptor;
  /** Base timeout in milliseconds (adjusted by tool scope) */
  baseTimeoutMs?: number;
}

/**
 * Resource profiles by programming language (Layer 4 tuning tables)
 * Used to auto-configure CPU/memory based on tool's primary language
 * @internal
 */
const LANGUAGE_RESOURCE_PROFILES: Record<string, { cpu: number; memory: number }> = {
  typescript: { cpu: 80, memory: 512 },      // Medium CPU (event-driven), medium memory
  javascript: { cpu: 80, memory: 512 },      // Same as TypeScript
  python: { cpu: 75, memory: 512 },          // Slightly more CPU, same memory
  go: { cpu: 70, memory: 256 },              // Lower CPU (compiled), less memory
  rust: { cpu: 70, memory: 256 },            // Similar to Go
  csharp: { cpu: 60, memory: 1024 },         // Heavy CPU (JIT), more memory
  java: { cpu: 60, memory: 1024 },           // Same as C#
  cpp: { cpu: 60, memory: 1024 },            // Same as C#
  ruby: { cpu: 75, memory: 512 },            // Similar to Python
  unknown: { cpu: 75, memory: 512 },         // Conservative defaults
};

/**
 * Timeout multipliers by tool scope (Layer 4 tuning)
 * Cloud services need extra time for network latency
 * @internal
 */
const SCOPE_TIMEOUT_MULTIPLIERS: Record<string, number> = {
  cloud_service: 2.0,      // Network latency adds ~30s typical
  local_service: 1.0,      // Baseline (30s)
  embedded: 0.6,           // Optimized, faster (18s)
};

/**
 * Watchdog instance for monitoring a single process
 */
export class ResourceWatchdog {
  private pid: number;
  private config: {
    memoryMB: number;
    cpuWarnPercent: number;
    checkIntervalMs: number;
    maxHighResourceReadings: number;
  };
  private metrics: ProcessMetrics[] = [];
  private intervalHandle: number | null = null;
  private killed = false;
  private baselineTimer: ReturnType<typeof setTimeout> | undefined;
  private monitorResolve: ((alert: ResourceAlert | null) => void) | undefined;
  private alerts: ResourceAlert[] = [];
  private highResourceCount = 0;
  private outputGrowthRate = 0; // Bytes per second
  private runId: string | null;
  private tool: ToolDescriptor | null;
  private appliedToolConfig: { cpu: string; memory: string; timeout: number } | null = null;

  constructor(pid: number, config: WatchdogConfig = {}) {
    this.pid = pid;
    this.runId = config.runId || null;
    this.tool = config.tool || null;

    // Layer 4: Auto-tune resource limits based on tool metadata
    const tuned = this.autoTuneResources(config);

    this.config = {
      memoryMB: tuned.memoryMB,
      cpuWarnPercent: tuned.cpuWarnPercent,
      checkIntervalMs: config.checkIntervalMs ?? 500,
      maxHighResourceReadings: config.maxHighResourceReadings ?? 6,
    };
  }

  /**
   * Auto-tune resource limits based on tool language and scope
   * Layer 4: Resource Watchdog Integration
   *
   * Heuristics:
   * - Interpreted languages (Python, Ruby) need more CPU
   * - Compiled languages (Go, Rust) need less CPU, less memory
   * - Cloud services get 2x timeout (network latency)
   * - Embedded services get 0.6x timeout (optimized)
   *
   * @internal
   */
  private autoTuneResources(config: WatchdogConfig): { memoryMB: number; cpuWarnPercent: number } {
    // If tool metadata provided, use it for auto-tuning
    if (this.tool) {
      // Determine primary language (first in list)
      const primaryLanguage = this.tool.languages[0] || 'unknown';
      const profile = LANGUAGE_RESOURCE_PROFILES[primaryLanguage] || LANGUAGE_RESOURCE_PROFILES.unknown;

      // Apply resource profile
      const memoryMB = config.memoryMB ?? profile.memory;
      const cpuWarnPercent = config.cpuWarnPercent ?? profile.cpu;

      // Calculate timeout adjustment
      const timeoutMultiplier = SCOPE_TIMEOUT_MULTIPLIERS[this.tool.scope] || 1.0;
      const baseTimeout = config.baseTimeoutMs || 30000; // 30s baseline
      const adjustedTimeout = baseTimeout * timeoutMultiplier;

      // Store applied configuration for logging
      this.appliedToolConfig = {
        cpu: profile.cpu.toString(),
        memory: `${profile.memory}MB`,
        timeout: adjustedTimeout,
      };

      // Log configuration for audit trail
      console.log(
        `🔧 [Layer 4] Auto-tuned resources for ${this.tool.name}:`,
        `CPU: ${cpuWarnPercent}% (${primaryLanguage})`,
        `Memory: ${memoryMB}MB`,
        `Timeout: ${(adjustedTimeout / 1000).toFixed(1)}s (${timeoutMultiplier}x for ${this.tool.scope})`
      );

      return { memoryMB, cpuWarnPercent };
    }

    // No tool metadata - use provided or default
    return {
      memoryMB: config.memoryMB ?? 512,
      cpuWarnPercent: config.cpuWarnPercent ?? 80,
    };
  }

  /**
   * Get the applied tool configuration (for audit trail)
   * Layer 4 debugging support
   */
  public getAppliedToolConfig(): Record<string, string | number> | null {
    return this.appliedToolConfig;
  }

  /**
   * Start monitoring the process
   * Returns a promise that resolves when monitoring is stopped or process killed
   */
  public async start(stepId: string, outputLength: number = 0): Promise<ResourceAlert | null> {
    // Track initial output length for growth detection
    if (outputLength > 0) {
      this.outputGrowthRate = 0;
    }

    this.cleanup();
    return new Promise((resolve) => {
      this.monitorResolve = resolve;
      // Schedule first baseline check in 100ms
      this.baselineTimer = setTimeout(() => {
        this.captureBaseline(stepId);
      }, 100);

      this.intervalHandle = setInterval(() => {
        const alert = this.checkMetrics(stepId);
        if (alert) {
          resolve(alert);
          this.cleanup();
        }
      }, this.config.checkIntervalMs) as unknown as number;
    });
  }

  /**
   * Stop monitoring and return any collected alerts
   * Alert persistence happens asynchronously in background (non-blocking)
   */
  public stop(): ResourceAlert[] {
    this.cleanup();

    // Persist alerts asynchronously in background (non-blocking)
    // This ensures durability without changing the public API
    if (this.runId && this.alerts.length > 0) {
      // Fire and forget - persistence doesn't block return
      this.persistAlerts().catch((error) => {
        console.error(`⚠️  Failed to persist alerts: ${error}`);
      });
    }

    return this.alerts;
  }

  /**
   * Load persisted alerts from disk for recovery
   * Call this after a process crash to retrieve the alert history
   * @static
   */
  public static async loadPersistedAlerts(runId: string): Promise<ResourceAlert[]> {
    try {
      const runDir = getRunDirectory(runId);
      const alertsFile = join(runDir, 'alerts.jsonl');

      const { readFile } = await import('fs/promises');
      const content = await readFile(alertsFile, 'utf-8');

      const alerts: ResourceAlert[] = [];
      for (const line of content.split('\n')) {
        if (line.trim()) {
          alerts.push(JSON.parse(line));
        }
      }

      return alerts;
    } catch (error) {
      // File doesn't exist or is unreadable - return empty
      return [];
    }
  }

  /**
   * Persist alerts to alerts.jsonl for durability
   * Called on stop() to ensure alerts survive process termination
   * @internal
   */
  private async persistAlerts(): Promise<void> {
    if (!this.runId) return;

    const runDir = getRunDirectory(this.runId);
    const alertsFile = join(runDir, 'alerts.jsonl');

    for (const alert of this.alerts) {
      const line = JSON.stringify(alert) + '\n';
      await appendFile(alertsFile, line);
    }
  }

  /**
   * Update output length for growth rate tracking
   */
  public updateOutputLength(newLength: number): void {
    // Track for growth rate analysis during process execution
    // This helps detect runaway processes that produce excessive output
    if (newLength > 1024 * 100) {
      // Output >100KB indicates potential runaway
      this.outputGrowthRate = newLength;
    }
  }

  /**
   * Capture baseline metrics after process starts
   * Used to differentiate initial startup overhead from actual resource issues
   * Layer 4: Include tool configuration in baseline log
   */
  private captureBaseline(stepId: string): void {
    try {
      const metrics = captureProcessMetrics(this.pid);

      // Layer 4: Include tool-aware configuration in baseline message
      let message = `⏱️ Baseline: ${metrics.memoryMB.toFixed(1)}MB, ${metrics.cpuPercent.toFixed(1)}% CPU`;
      if (this.tool) {
        message += ` [${this.tool.name} - ${this.tool.languages.join(',')}]`;
      }

      // Log baseline for audit trail
      this.alerts.push({
        stepId,
        alertType: 'cpu',
        actualValue: metrics.cpuPercent,
        limitValue: this.config.cpuWarnPercent,
        unit: '%',
        timestamp: metrics.timestamp,
        message,
        pid: this.pid,
      });
    } catch {
      // Baseline capture failed - continue monitoring anyway
    }
  }

  /**
   * Check process metrics and return alert if limits exceeded
   */
  private checkMetrics(stepId: string): ResourceAlert | null {
    try {
      const metrics = captureProcessMetrics(this.pid);
      this.metrics.push(metrics);

      // Keep only last 20 readings for memory analysis
      if (this.metrics.length > 20) {
        this.metrics.shift();
      }

      // Memory check
      if (metrics.memoryMB > this.config.memoryMB) {
        const alert: ResourceAlert = {
          stepId,
          alertType: 'memory',
          actualValue: metrics.memoryMB,
          limitValue: this.config.memoryMB,
          unit: 'MB',
          timestamp: metrics.timestamp,
          message: `🛑 Memory limit exceeded: ${metrics.memoryMB.toFixed(1)}MB > ${this.config.memoryMB}MB`,
          pid: this.pid,
        };

        this.alerts.push(alert);
        this.killProcess();

        return alert;
      }

      // CPU check - detect sustained high usage or runaway growth
      const isHighCpu = metrics.cpuPercent > this.config.cpuWarnPercent;
      const isMemoryLeaking = this.detectMemoryLeak();
      const isOutputGrowing = this.detectRunawayOutput();

      if (isHighCpu || isMemoryLeaking || isOutputGrowing) {
        this.highResourceCount++;

        if (this.highResourceCount >= this.config.maxHighResourceReadings) {
          // Determine alert type and message
          let alertType: 'cpu' | 'memory' | 'process_killed' = 'cpu';
          let message = '';

          if (isMemoryLeaking) {
            alertType = 'memory';
            message = `🛑 Memory leak detected: RSS reached ${metrics.memoryMB.toFixed(1)}MB`;
          } else if (isOutputGrowing) {
            message = `🛑 Runaway output detected: Growing at ${(this.outputGrowthRate / 1024).toFixed(1)}KB/s`;
          } else {
            message = `🛑 Sustained high CPU: ${metrics.cpuPercent.toFixed(1)}% > ${this.config.cpuWarnPercent}% (AI may be stuck)`;
          }

          const alert: ResourceAlert = {
            stepId,
            alertType,
            actualValue: alertType === 'memory' ? metrics.memoryMB : metrics.cpuPercent,
            limitValue: alertType === 'memory' ? this.config.memoryMB : this.config.cpuWarnPercent,
            unit: alertType === 'memory' ? 'MB' : '%',
            timestamp: metrics.timestamp,
            message,
            pid: this.pid,
          };

          this.alerts.push(alert);
          this.killProcess();

          return alert;
        }
      } else {
        // Reset high resource counter if metrics normalize
        this.highResourceCount = 0;
      }

      return null;
    } catch (error) {
      // Metrics capture failed - could mean process ended or died
      return null;
    }
  }

  /**
   * Detect if memory is growing exponentially (memory leak pattern)
   */
  private detectMemoryLeak(): boolean {
    if (this.metrics.length < 5) {
      return false; // Need enough samples
    }

    const recent = this.metrics.slice(-5);
    const memoryGrowth = [];

    for (let i = 1; i < recent.length; i++) {
      memoryGrowth.push(recent[i].memoryMB - recent[i - 1].memoryMB);
    }

    // If last 3 readings show consistent growth >2MB per check (avg 1MB per 500ms = 2MB/s)
    const avgGrowth =
      memoryGrowth.slice(-3).reduce((a, b) => a + b, 0) / 3;
    return avgGrowth > 2; // More than 2MB per check = runaway leak
  }

  /**
   * Detect if output is growing exponentially (infinite loop dumping data)
   */
  private detectRunawayOutput(): boolean {
    // This is approximate - we track via updateOutputLength calls
    if (this.metrics.length < 5) {
      return false;
    }

    // If output is growing >100KB per second
    return this.outputGrowthRate > 100 * 1024;
  }

  /**
   * Kill the process
   */
  private killProcess(): void {
    if (this.killed) {
      return;
    }

    this.killed = true;

    try {
      // Terminate the monitored PID.
      process.kill(this.pid, 'SIGKILL');
    } catch {
      // Process may already be dead
    }
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.baselineTimer !== undefined) clearTimeout(this.baselineTimer);
    this.monitorResolve?.(null);
    this.monitorResolve = undefined;
  }
}

/**
 * Capture current process metrics from /proc filesystem (Linux) or ps command (macOS/Windows)
 * Returns memory in MB and CPU as percentage (0-100)
 *
 * @internal
 */
export function captureProcessMetrics(pid: number): ProcessMetrics {
  const timestamp = new Date();
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  if (pid === process.pid) {
    const cpu = process.cpuUsage();
    return { pid, memoryMB: process.memoryUsage().rss / 1024 / 1024,
      cpuPercent: Math.min(100, (cpu.user + cpu.system) / (Math.max(process.uptime(), 0.001) * 10000)), timestamp };
  }
  if (process.platform === 'win32') {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; @{ memoryMB = $p.WorkingSet64 / 1MB; cpuPercent = [Math]::Min(100, 100 * $p.CPU / [Math]::Max(0.001, ((Get-Date) - $p.StartTime).TotalSeconds)) } | ConvertTo-Json -Compress`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const metrics: { memoryMB: number; cpuPercent: number } = JSON.parse(output);
    return { pid, timestamp, ...metrics };
  }

  // Fallback: Use ps command (works on macOS, Linux, may work on Windows)
  try {
    return captureProcessMetricsWithPs(pid, timestamp);
  } catch (error) {
    throw new Error(`Failed to capture metrics for PID ${pid}: ${error}`);
  }
}

/**
 * Capture metrics using ps command (cross-platform)
 * @internal
 */
function captureProcessMetricsWithPs(pid: number, timestamp: Date): ProcessMetrics {


  try {
    // ps output: PID %CPU %MEM RSS
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pcpu=,pmem=,rss='], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    const parts = output.split(/\s+/);

    if (parts.length < 4) {
      throw new Error('Invalid ps output');
    }

    const cpuPercent = parseFloat(parts[1]);
    const memoryMB = parseInt(parts[3], 10) / 1024; // Convert KB to MB

    return {
      pid,
      memoryMB: Math.max(0, memoryMB),
      cpuPercent: Math.max(0, Math.min(100, cpuPercent)),
      timestamp,
    };
  } catch (error) {
    throw new Error(`Failed to execute ps command: ${error}`);
  }
}

/** Drain both streams and wait for the child before releasing the watchdog. */
export async function spawnMonitored(
  command: string[],
  watchdogConfig: WatchdogConfig = {},
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<{ output: string; stderr: string; exitCode: number; alerts: ResourceAlert[] }> {
  options.signal?.throwIfAborted();
  const proc = spawn(command, { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const watchdog = new ResourceWatchdog(proc.pid, watchdogConfig);
  void watchdog.start('spawned-process');
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return text + decoder.decode();
        size += value.byteLength;
        if (size > 5 * 1024 * 1024) throw new Error('Child process output exceeded 5 MiB');
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
  }
  let alerts: ResourceAlert[];
  let result: { output: string; stderr: string; exitCode: number };
  try {
    const [output, stderr, exitCode] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
    result = { output, stderr, exitCode };
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await proc.exited;
    alerts = watchdog.stop();
  }
  return { ...result, alerts };
}
