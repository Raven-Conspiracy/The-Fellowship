/**
 * =============================================================================
 * Structured JSON Logger — The Fellowship Orchestrator
 * =============================================================================
 *
 * Provides a Pino-based logger implementation conforming to the Logger interface.
 * Supports:
 *   - Structured JSON logging (stdout)
 *   - Pretty-printed output for development
 *   - Child loggers with bound context
 *   - Configurable log levels
 *   - Noop logger for testing
 */

import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

import { LogLevel } from './types.js';
import type { Logger } from './types.js';

// ============================================================================
// Pino Logger Implementation
// ============================================================================

/**
 * Configuration for creating a logger.
 */
export interface CreateLoggerOptions {
  /** The minimum log level to output */
  level: LogLevel;
  /** Whether to use pretty-printing (default: false → JSON) */
  pretty: boolean;
  /** Base context to include in every log entry */
  base?: Record<string, unknown>;
  /** Custom pino options (override defaults) */
  pinoOptions?: LoggerOptions;
}

/**
 * Maps our LogLevel enum to pino's string levels.
 */
const LOG_LEVEL_MAP: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
};

/**
 * Pino-based Logger implementation.
 */
class PinoLoggerImpl implements Logger {
  private readonly pino: PinoLogger;

  constructor(pinoInstance: PinoLogger) {
    this.pino = pinoInstance;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.pino.debug(context ?? {}, message);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.pino.info(context ?? {}, message);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.pino.warn(context ?? {}, message);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.pino.error(context ?? {}, message);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerImpl(this.pino.child(bindings));
  }

  get level(): LogLevel {
    const pinoLevel = this.pino.level;
    // Map pino's numeric/string level back to our LogLevel
    const levelStr =
      typeof pinoLevel === 'string' ? pinoLevel : pino.levels.labels[pinoLevel] ?? 'info';
    switch (levelStr) {
      case 'debug':
        return LogLevel.DEBUG;
      case 'info':
        return LogLevel.INFO;
      case 'warn':
        return LogLevel.WARN;
      case 'error':
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }
}

/**
 * Create a logger instance.
 *
 * @param options - Logger configuration
 * @returns A Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger({ level: LogLevel.DEBUG, pretty: true });
 * logger.info('Graph execution started', { graphName: 'triage' });
 * ```
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const { level, pretty, base, pinoOptions } = options;

  const levelStr = LOG_LEVEL_MAP[level];

  const defaultOptions: LoggerOptions = {
    level: levelStr,
    base: base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };

  const mergedOptions: LoggerOptions = { ...defaultOptions, ...pinoOptions };

  let pinoInstance: PinoLogger;

  if (pretty) {
    // Dynamic import of pino-pretty for dev mode
    pinoInstance = pino({
      ...mergedOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      },
    });
  } else {
    pinoInstance = pino(mergedOptions);
  }

  return new PinoLoggerImpl(pinoInstance);
}

/**
 * Create a logger from environment configuration.
 *
 * @param env - Environment variables
 * @returns A Logger instance
 */
export function createLoggerFromEnv(env: {
  LOG_LEVEL?: string;
  STRUCTURED_LOGGING?: string;
}): Logger {
  const level = parseLogLevel(env.LOG_LEVEL ?? 'info');
  const pretty = env.STRUCTURED_LOGGING !== 'true';

  return createLogger({
    level,
    pretty,
    base: {
      service: 'the-fellowship-orchestrator',
    },
  });
}

/**
 * Parse a log level string into a LogLevel enum value.
 *
 * @param levelStr - The log level string
 * @returns The corresponding LogLevel
 */
function parseLogLevel(levelStr: string): LogLevel {
  switch (levelStr.toLowerCase()) {
    case 'debug':
      return LogLevel.DEBUG;
    case 'info':
      return LogLevel.INFO;
    case 'warn':
    case 'warning':
      return LogLevel.WARN;
    case 'error':
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
}

// ============================================================================
// Noop Logger (for testing)
// ============================================================================

/**
 * A no-operation logger that discards all log messages.
 * Useful for unit tests where logging output is not needed.
 *
 * @example
 * ```typescript
 * const logger = noopLogger;
 * logger.info('this will not be logged');
 * ```
 */
class NoopLoggerImpl implements Logger {
  debug(_message: string, _context?: Record<string, unknown>): void {
    // noop
  }

  info(_message: string, _context?: Record<string, unknown>): void {
    // noop
  }

  warn(_message: string, _context?: Record<string, unknown>): void {
    // noop
  }

  error(_message: string, _context?: Record<string, unknown>): void {
    // noop
  }

  child(_bindings: Record<string, unknown>): Logger {
    return this; // Noop logger is stateless
  }

  get level(): LogLevel {
    return LogLevel.ERROR; // Effectively disabled
  }
}

/**
 * Singleton noop logger instance for testing.
 */
export const noopLogger: Logger = new NoopLoggerImpl();

// ============================================================================
// In-Memory Logger (for test assertions)
// ============================================================================

/**
 * A log entry stored in memory.
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  timestamp: string;
}

/**
 * An in-memory logger that captures log entries for test assertions.
 *
 * @example
 * ```typescript
 * const logger = new InMemoryLogger();
 * logger.info('test');
 * expect(logger.entries).toHaveLength(1);
 * ```
 */
export class InMemoryLogger implements Logger {
  private readonly _entries: LogEntry[] = [];

  debug(message: string, context?: Record<string, unknown>): void {
    this._entries.push({
      level: LogLevel.DEBUG,
      message,
      context: context ?? {},
      timestamp: new Date().toISOString(),
    });
  }

  info(message: string, context?: Record<string, unknown>): void {
    this._entries.push({
      level: LogLevel.INFO,
      message,
      context: context ?? {},
      timestamp: new Date().toISOString(),
    });
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this._entries.push({
      level: LogLevel.WARN,
      message,
      context: context ?? {},
      timestamp: new Date().toISOString(),
    });
  }

  error(message: string, context?: Record<string, unknown>): void {
    this._entries.push({
      level: LogLevel.ERROR,
      message,
      context: context ?? {},
      timestamp: new Date().toISOString(),
    });
  }

  child(bindings: Record<string, unknown>): Logger {
    const childLogger = new InMemoryLogger();
    // Note: bindings would be applied to each log entry in a real implementation
    childLogger._entries.push(...this._entries);
    return childLogger;
  }

  /** All captured log entries */
  get entries(): ReadonlyArray<LogEntry> {
    return this._entries;
  }

  /** Clear all captured entries */
  clear(): void {
    this._entries.length = 0;
  }

  /** Get entries filtered by level */
  entriesByLevel(level: LogLevel): ReadonlyArray<LogEntry> {
    return this._entries.filter((e) => e.level === level);
  }

  get level(): LogLevel {
    return LogLevel.DEBUG;
  }
}
