/**
 * Logger Mock
 *
 * Mock implementation of the structured `Logger` that captures all log
 * calls for test assertions. This allows tests to verify that specific
 * log messages were emitted at the expected levels.
 *
 * ## Usage
 *
 * ```typescript
 * import { createMockLogger } from "../../mocks/logger.mock.js";
 *
 * const logger = createMockLogger();
 * logger.info({ key: "value" }, "test message");
 *
 * expect(logger.getLogsAtLevel("info")).toHaveLength(1);
 * expect(logger.getLogsAtLevel("info")[0].message).toBe("test message");
 * expect(logger.getLogsAtLevel("info")[0].context).toEqual({ key: "value" });
 * ```
 */

import { vi } from "vitest";
import type { Logger, LogLevel } from "../../src/core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogEntry {
  level: LogLevel;
  context: Record<string, unknown>;
  message: string;
  timestamp: string;
}

export interface MockLogger extends Logger {
  /** Retrieve all captured log entries */
  getLogs: () => LogEntry[];
  /** Retrieve logs filtered by level */
  getLogsAtLevel: (level: LogLevel) => LogEntry[];
  /** Retrieve logs whose message contains a substring */
  getLogsContaining: (substring: string) => LogEntry[];
  /** Check if any log at the given level matches a predicate */
  hasLog: (level: LogLevel, predicate: (entry: LogEntry) => boolean) => boolean;
  /** Clear all captured logs */
  clearLogs: () => void;
  /** Reset all mock counters (Vitest mockClear) */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a mock `Logger` that captures all log calls.
 *
 * The returned logger implements the standard `Logger` interface (info, warn,
 * error, debug, child) but instead of writing to stdout/stderr, it records
 * entries in memory for later assertion.
 *
 * @param baseContext - Optional context merged into every log entry
 */
export function createMockLogger(baseContext: Record<string, unknown> = {}): MockLogger {
  const logs: LogEntry[] = [];

  function makeLogFn(level: LogLevel) {
    return vi.fn((contextOrMessage: Record<string, unknown> | string, message?: string) => {
      let context: Record<string, unknown> = {};
      let msg: string;

      if (typeof contextOrMessage === "string") {
        msg = contextOrMessage;
      } else {
        context = contextOrMessage ?? {};
        msg = message ?? "";
      }

      logs.push({
        level,
        context: { ...baseContext, ...context },
        message: msg,
        timestamp: new Date().toISOString(),
      });
    });
  }

  const debug = makeLogFn("debug");
  const info = makeLogFn("info");
  const warn = makeLogFn("warn");
  const error = makeLogFn("error");

  const child = vi.fn((childContext: Record<string, unknown>): Logger => {
    return createMockLogger({ ...baseContext, ...childContext }) as unknown as Logger;
  });

  const logger: MockLogger = {
    debug,
    info,
    warn,
    error,
    child: child as any,

    getLogs() {
      return [...logs];
    },

    getLogsAtLevel(level: LogLevel) {
      return logs.filter((l) => l.level === level);
    },

    getLogsContaining(substring: string) {
      return logs.filter((l) => l.message.includes(substring));
    },

    hasLog(level: LogLevel, predicate: (entry: LogEntry) => boolean) {
      return logs.some((l) => l.level === level && predicate(l));
    },

    clearLogs() {
      logs.length = 0;
    },

    reset() {
      logs.length = 0;
      debug.mockClear();
      info.mockClear();
      warn.mockClear();
      error.mockClear();
      child.mockClear();
    },
  };

  return logger;
}
