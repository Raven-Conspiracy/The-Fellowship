/**
 * =============================================================================
 * Retry Utility — Exponential Backoff with Jitter
 * =============================================================================
 *
 * Implements exponential backoff retry with:
 *   - Configurable max attempts, base delay, max delay, multiplier
 *   - Full jitter for thundering herd prevention
 *   - Non-retryable error detection
 *   - Per-attempt logging with structured context
 *   - Abort signal support
 */

import type { Logger } from '../core/types.js';
import { LogLevel } from '../core/types.js';
import { isRetryableError } from '../core/errors.js';
import type { RetryPolicy } from '../core/types.js';
import { DEFAULT_RETRY_POLICY } from '../core/types.js';
import type { OrchestrationError } from '../core/errors.js';

// ============================================================================
// Retry Options
// ============================================================================

/**
 * Extended options for retry execution.
 */
export interface RetryOptions extends RetryPolicy {
  /** Logger instance for retry attempts */
  logger?: Logger;
  /** AbortSignal for cancelling retries */
  signal?: AbortSignal;
  /** Custom function to determine if an error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Called before each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

// ============================================================================
// Retry State
// ============================================================================

/**
 * Tracks retry execution state.
 */
interface RetryState {
  attempt: number;
  lastError?: Error;
  startTime: number;
}

// ============================================================================
// Core Retry Function
// ============================================================================

/**
 * Execute an async function with exponential backoff retry.
 *
 * @param fn - The async function to execute with retry
 * @param options - Retry configuration options
 * @returns A promise that resolves with the function's return value
 * @throws The last error encountered if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => {
 *     const res = await fetch('https://api.example.com');
 *     if (!res.ok) throw new Error(`HTTP ${res.status}`);
 *     return res.json();
 *   },
 *   { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, jitter: true }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY_POLICY,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    backoffMultiplier,
    jitter,
    logger,
    signal,
    isRetryable = isRetryableError,
    onRetry,
  } = options;

  const state: RetryState = {
    attempt: 1,
    startTime: Date.now(),
  };

  while (state.attempt <= maxAttempts) {
    try {
      // Check for abort before execution
      if (signal?.aborted) {
        throw new Error('Retry operation was aborted');
      }

      const result = await fn(state.attempt);

      // Success — log and return
      if (state.attempt > 1) {
        logger?.info('Retry succeeded', {
          attempt: state.attempt,
          totalDurationMs: Date.now() - state.startTime,
        });
      }

      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      state.lastError = err;

      // Check if this error is non-retryable
      if (!isRetryable(err)) {
        logger?.warn('Non-retryable error encountered — not retrying', {
          attempt: state.attempt,
          errorMessage: err.message,
          errorName: err.name,
        });
        throw err;
      }

      // Check if we've exhausted attempts
      if (state.attempt >= maxAttempts) {
        logger?.error('All retry attempts exhausted', {
          maxAttempts,
          lastError: err.message,
          totalDurationMs: Date.now() - state.startTime,
          level: LogLevel.ERROR,
        });
        throw err;
      }

      // Calculate delay with exponential backoff and optional jitter
      const delayMs = calculateRetryDelay(
        state.attempt,
        baseDelayMs,
        maxDelayMs,
        backoffMultiplier,
        jitter,
      );

      logger?.warn('Retrying after error', {
        attempt: state.attempt,
        nextAttempt: state.attempt + 1,
        delayMs,
        errorMessage: err.message,
        errorName: err.name,
        totalDurationMs: Date.now() - state.startTime,
      });

      onRetry?.(state.attempt, err, delayMs);

      // Wait for the delay, respecting abort signal
      await delayWithAbort(delayMs, signal);

      state.attempt++;
    }
  }

  // This shouldn't be reached, but TypeScript needs it
  throw state.lastError ?? new Error('Retry failed for unknown reason');
}

// ============================================================================
// Delay Calculation
// ============================================================================

/**
 * Calculate the delay for a given retry attempt using exponential backoff.
 *
 * Formula: min(baseDelay * (backoffMultiplier ^ (attempt - 1)), maxDelay)
 * With optional full jitter: random(0, calculatedDelay)
 *
 * @param attempt - Current attempt number (1-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param backoffMultiplier - Exponential backoff multiplier
 * @param jitter - Whether to add random jitter
 * @returns The calculated delay in milliseconds
 */
function calculateRetryDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number,
  jitter: boolean,
): number {
  // Calculate exponential backoff
  // attempt 1 → baseDelay * multiplier^0 = baseDelay
  // attempt 2 → baseDelay * multiplier^1
  // attempt 3 → baseDelay * multiplier^2
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (!jitter) {
    return cappedDelay;
  }

  // Full jitter: random between 0 and cappedDelay
  // This prevents thundering herd by spreading retries across time
  return Math.floor(Math.random() * (cappedDelay + 1));
}

/**
 * Create a promise that resolves after a delay, respecting an AbortSignal.
 *
 * @param ms - Delay in milliseconds
 * @param signal - Optional AbortSignal to cancel the delay
 * @returns A promise that resolves after the delay or rejects if aborted
 */
function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Delay aborted'));
      return;
    }

    const timeoutId = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Delay aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ============================================================================
// Decorator / Wrapper
// ============================================================================

/**
 * Create a retryable version of an async function.
 * The returned function has the same signature as the original.
 *
 * @param fn - The async function to wrap with retry
 * @param options - Retry configuration (without `onRetry`)
 * @returns A function with the same signature that retries on failure
 *
 * @example
 * ```typescript
 * const fetchWithRetry = retryable(fetch, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, jitter: true });
 * const response = await fetchWithRetry('https://api.example.com');
 * ```
 */
export function retryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions,
): T {
  return (async (...args: unknown[]): Promise<unknown> => {
    return withRetry(
      () => fn(...args),
      options,
    );
  }) as T;
}

// ============================================================================
// Retry Policy Builder
// ============================================================================

/**
 * Create a RetryPolicy from partial options, filling in defaults.
 *
 * @param partial - Partial retry policy options
 * @returns A complete RetryPolicy
 */
export function createRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  return {
    maxAttempts: partial?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: partial?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: partial?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    backoffMultiplier: partial?.backoffMultiplier ?? DEFAULT_RETRY_POLICY.backoffMultiplier,
    jitter: partial?.jitter ?? DEFAULT_RETRY_POLICY.jitter,
  };
}

// ============================================================================
// Non-Retryable Error Detection
// ============================================================================

/**
 * HTTP status codes that should NOT be retried (client errors).
 */
const NON_RETRYABLE_STATUS_CODES = new Set([
  400, // Bad Request
  401, // Unauthorized
  402, // Payment Required
  403, // Forbidden
  404, // Not Found
  405, // Method Not Allowed
  406, // Not Acceptable
  409, // Conflict (idempotency issues)
  410, // Gone
  411, // Length Required
  412, // Precondition Failed
  413, // Payload Too Large
  414, // URI Too Long
  415, // Unsupported Media Type
  416, // Range Not Satisfiable
  417, // Expectation Failed
  422, // Unprocessable Entity
]);

/**
 * Check if an HTTP status code represents a non-retryable error.
 *
 * @param statusCode - The HTTP status code
 * @returns true if the status code should not be retried
 */
export function isNonRetryableHttpStatus(statusCode: number): boolean {
  return NON_RETRYABLE_STATUS_CODES.has(statusCode);
}

/**
 * HTTP status codes that should ALWAYS be retried.
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * Check if an HTTP status code represents a retryable error.
 *
 * @param statusCode - The HTTP status code
 * @returns true if the status code should be retried
 */
export function isRetryableHttpStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS_CODES.has(statusCode);
}
