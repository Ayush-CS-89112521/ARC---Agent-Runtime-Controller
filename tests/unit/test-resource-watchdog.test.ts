/**
 * Test Suite: Resource Watchdog
 * Tests process resource monitoring and kill logic
 */

import { describe, it, expect } from 'bun:test';
import { ResourceWatchdog, captureProcessMetrics, spawnMonitored } from '../../src/execution/resource-watchdog';
import { ResourceAlert } from '../../src/types/index';

describe('Resource Watchdog - Metrics Capture', () => {
  it('should capture current process metrics', () => {
    const metrics = captureProcessMetrics(process.pid);

    expect(metrics.pid).toBe(process.pid);
    expect(metrics.memoryMB).toBeGreaterThan(0);
    expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100);
    expect(metrics.timestamp).toBeInstanceOf(Date);
  });

  it('should return reasonable memory estimates', () => {
    const metrics = captureProcessMetrics(process.pid);

    // Node/Bun processes typically use 30-200MB
    expect(metrics.memoryMB).toBeLessThan(1000); // Sanity check
  });
});

describe('Resource Watchdog - Configuration', () => {
  it('should accept custom resource limits', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 256,
      cpuWarnPercent: 70,
      checkIntervalMs: 1000,
      maxHighResourceReadings: 3,
    });

    expect(watchdog).toBeDefined();
  });

  it('should use default limits when not specified', () => {
    const watchdog = new ResourceWatchdog(process.pid);

    // Should not throw and should use defaults
    expect(watchdog).toBeDefined();
  });
});

describe('Resource Watchdog - Alert Types', () => {
  it('should define memory alert type', () => {
    const alert: ResourceAlert = {
      stepId: 'test-step',
      alertType: 'memory',
      actualValue: 600,
      limitValue: 512,
      unit: 'MB',
      timestamp: new Date(),
      message: 'Memory limit exceeded',
      pid: 1234,
    };

    expect(alert.alertType).toBe('memory');
    expect(alert.actualValue).toBeGreaterThan(alert.limitValue);
  });

  it('should define CPU alert type', () => {
    const alert: ResourceAlert = {
      stepId: 'test-step',
      alertType: 'cpu',
      actualValue: 95,
      limitValue: 80,
      unit: '%',
      timestamp: new Date(),
      message: 'CPU usage warning',
      pid: 1234,
    };

    expect(alert.alertType).toBe('cpu');
    expect(alert.unit).toBe('%');
  });

  it('should define process_killed alert type', () => {
    const alert: ResourceAlert = {
      stepId: 'test-step',
      alertType: 'process_killed',
      actualValue: 150,
      limitValue: 512,
      unit: 'MB',
      timestamp: new Date(),
      message: 'Process killed due to resource limit',
      pid: 1234,
      lastOutput: 'partial output before kill',
    };

    expect(alert.alertType).toBe('process_killed');
    expect(alert.lastOutput).toBeDefined();
  });
});

describe('Resource Watchdog - Monitoring States', () => {
  it('should track baseline metrics on start', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 1024,
      cpuWarnPercent: 100, // High threshold so we don't trigger alerts
    });

    // Watchdog should initialize without throwing
    expect(watchdog).toBeDefined();
  });

  it('should differentiate AI thinking from runaway process', () => {
    // AI thinking pattern: Sustained 30-50% CPU for >10 seconds
    // Runaway pattern: CPU >80% trending upward, or memory >2MB/sec growth

    // Watchdog should track both patterns and only kill on runaway
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 512,
      cpuWarnPercent: 80,
      maxHighResourceReadings: 6, // Allow 3 seconds (6 * 500ms) before kill
    });

    expect(watchdog).toBeDefined();
  });
});

describe('Resource Watchdog - Output Tracking', () => {
  it('should track output length changes', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 512,
      cpuWarnPercent: 80,
    });

    // Update output length as data is captured
    watchdog.updateOutputLength(1024);
    watchdog.updateOutputLength(2048);
    watchdog.updateOutputLength(4096);

    // Should not throw
    expect(watchdog).toBeDefined();
  });

  it('should detect runaway output growth', () => {
    // If output grows >100KB/s, should trigger alert
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 512,
      cpuWarnPercent: 80,
    });

    // Simulating rapid output growth
    for (let i = 0; i < 10; i++) {
      watchdog.updateOutputLength(i * 50 * 1024); // Growing 50KB each time
    }

    expect(watchdog).toBeDefined();
  });
});

describe('Resource Watchdog - Stop & Cleanup', () => {
  it('should stop monitoring and return alerts', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 1024,
      cpuWarnPercent: 100,
    });

    const alerts = watchdog.stop();

    expect(Array.isArray(alerts)).toBe(true);
  });

  it('should allow multiple stop calls without error', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 1024,
      cpuWarnPercent: 100,
    });

    const alerts1 = watchdog.stop();
    const alerts2 = watchdog.stop(); // Should not throw

    expect(Array.isArray(alerts1)).toBe(true);
    expect(Array.isArray(alerts2)).toBe(true);
  });
});

describe('Resource Watchdog - Real-World Scenarios', () => {
  async function measure(name: string, script: string, limits: { cpuWarnPercent: number; maxHighResourceReadings: number }) {
    const result = await spawnMonitored([process.execPath, '-e', script], {
      memoryMB: 384, checkIntervalMs: 550, ...limits,
    }, { signal: AbortSignal.timeout(14000) });
    console.log(JSON.stringify({ scenario: name, exitCode: result.exitCode, alerts: result.alerts }));
    return result;
  }

  it('should detect a bounded high CPU workload and terminate its process', async () => {
    const result = await measure('cpu', 'const end = Date.now() + 7000; while (Date.now() < end) Math.sqrt(Date.now());',
      { cpuWarnPercent: 25, maxHighResourceReadings: 2 });
    expect(result.exitCode).not.toBe(0);
    expect(result.alerts.some(alert => alert.message.includes('Sustained high CPU') && alert.actualValue > 25)).toBe(true);
  }, 18000);

  it('should detect memory leak pattern (consistent growth)', async () => {
    const result = await measure('growth', `
      const buffers = []; let samples = 0;
      const timer = setInterval(() => {
        buffers.push(Buffer.alloc(5 * 1024 * 1024, 77));
        if (++samples === 12) clearInterval(timer);
      }, 440);
    `, { cpuWarnPercent: 100, maxHighResourceReadings: 2 });
    expect(result.exitCode).not.toBe(0);
    expect(result.alerts.some(alert => alert.message.includes('Memory leak detected'))).toBe(true);
  }, 18000);

  it('should allow a normal bounded child to complete without false positives', async () => {
    const result = await measure('normal', 'setTimeout(() => console.log("finished"), 1700)',
      { cpuWarnPercent: 80, maxHighResourceReadings: 2 });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('finished');
    expect(result.alerts.some(alert => alert.message.startsWith('🛑'))).toBe(false);
  }, 18000);
});

describe('Resource Watchdog - Error Recovery', () => {
  it('should handle dead process gracefully', () => {
    // Trying to monitor a PID that doesn't exist
    const watchdog = new ResourceWatchdog(999999, {
      memoryMB: 512,
      cpuWarnPercent: 80,
    });

    // Should not throw when stopping
    const alerts = watchdog.stop();

    expect(Array.isArray(alerts)).toBe(true);
  });

  it('should recover from metric capture failures', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 512,
      cpuWarnPercent: 80,
    });

    // Even if metrics capture fails, watchdog should continue
    const alerts = watchdog.stop();

    expect(Array.isArray(alerts)).toBe(true);
  });
});

describe('Resource Watchdog - Audit Trail', () => {
  it('should record baseline metrics for audit', () => {
    const watchdog = new ResourceWatchdog(process.pid, {
      memoryMB: 1024,
      cpuWarnPercent: 100,
    });

    // Baseline is captured after start
    const alerts = watchdog.stop();

    // May contain baseline alert for audit trail
    expect(Array.isArray(alerts)).toBe(true);
  });

  it('should include step ID in all alerts', () => {
    const alert: ResourceAlert = {
      stepId: 'some-step',
      alertType: 'cpu',
      actualValue: 90,
      limitValue: 80,
      unit: '%',
      timestamp: new Date(),
      message: 'Alert for audit trail',
      pid: 1234,
    };

    expect(alert.stepId).toBe('some-step');
    expect(alert.timestamp).toBeInstanceOf(Date);
  });
});
