/**
 * =============================================================================
 * Result Utilities — The Fellowship Orchestrator
 * =============================================================================
 *
 * Re-exports the `neverthrow` library and provides domain-specific helpers:
 *   - DomainResult<T>: A Result type with OrchestrationError as the error type
 *   - AsyncDomainResult<T>: Promise-wrapped DomainResult
 *   - safeAsync(): Wraps an async function to return a Result instead of throwing
 *   - safeSync(): Wraps a sync function to return a Result instead of throwing
 *   - combineResults(): Combines multiple Results into a single Result
 */

import {
  ok,
  err,
  okAsync,
  errAsync,
  fromPromise,
  fromSafePromise,
  Result,
  ResultAsync,
} from 'neverthrow';

import type { OrchestrationError } from '../core/errors.js';

// ============================================================================
// Re-exports from neverthrow
// ============================================================================

export {
  ok,
  err,
  okAsync,
  errAsync,
  fromPromise,
  fromSafePromise,
  Result,
  ResultAsync,
};

// ============================================================================
// Domain-specific Result types
// ============================================================================

/**
 * A Result type where the error is always an OrchestrationError.
 * This is the standard return type for domain operations.
 */
export type DomainResult<T> = Result<T, OrchestrationError>;

/**
 * An async Result type where the error is always an OrchestrationError.
 */
export type AsyncDomainResult<T> = ResultAsync<T, OrchestrationError>;

// ============================================================================
// Safe Wrappers
// ============================================================================

/**
 * Wrap an async function to catch thrown errors and convert them to Result types.
 * Non-OrchestrationError errors are wrapped in a generic OrchestrationError.
 *
 * @param fn - The async function to wrap
 * @param errorMessage - Default error message if the caught error is not an OrchestrationError
 * @returns A function that returns AsyncDomainResult<T>
 *
 * @example
 * ```typescript
 * const safeFetch = safeAsync(async (url: string) => {
 *   const res = await fetch(url);
 *   return res.json();
 * }, 'Failed to fetch');
 *
 * const result = await safeFetch('https://api.example.com');
 * ```
 */
export function safeAsync<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  errorMessage: string,
): (...args: Args) => AsyncDomainResult<T> {
  return (...args: Args): AsyncDomainResult<T> => {
    return ResultAsync.fromSafePromise(
      (async () => {
        try {
          return await fn(...args);
        } catch (error) {
          throw wrapError(error, errorMessage);
        }
      })(),
    ) as AsyncDomainResult<T>;
  };
}

/**
 * Wrap a synchronous function to catch thrown errors and convert them to Result types.
 *
 * @param fn - The sync function to wrap
 * @param errorMessage - Default error message if the caught error is not an OrchestrationError
 * @returns A function that returns DomainResult<T>
 *
 * @example
 * ```typescript
 * const safeParse = safeSync((json: string) => JSON.parse(json), 'Failed to parse JSON');
 * const result = safeParse('{"valid": "json"}');
 * ```
 */
export function safeSync<T, Args extends unknown[]>(
  fn: (...args: Args) => T,
  errorMessage: string,
): (...args: Args) => DomainResult<T> {
  return (...args: Args): DomainResult<T> => {
    try {
      return ok(fn(...args));
    } catch (error) {
      return err(wrapError(error, errorMessage));
    }
  };
}

// ============================================================================
// Result Combination
// ============================================================================

/**
 * Combine an array of Results into a single Result.
 * If all Results are ok, returns ok with the array of values.
 * If any Result is err, returns the first error encountered.
 *
 * @param results - Array of Result objects
 * @returns A single combined Result
 *
 * @example
 * ```typescript
 * const results = [ok(1), ok(2), ok(3)];
 * const combined = combineResults(results); // ok([1, 2, 3])
 * ```
 */
export function combineResults<T, E extends Error>(
  results: ReadonlyArray<Result<T, E>>,
): Result<ReadonlyArray<T>, E> {
  return Result.combine(results);
}

/**
 * Combine an array of async Results into a single async Result.
 *
 * @param results - Array of ResultAsync objects
 * @returns A single combined ResultAsync
 */
export function combineAsyncResults<T, E extends Error>(
  results: ReadonlyArray<ResultAsync<T, E>>,
): ResultAsync<ReadonlyArray<T>, E> {
  return ResultAsync.combine(results);
}

// ============================================================================
// Result Utilities
// ============================================================================

/**
 * Unwrap a DomainResult, throwing if it's an error.
 * Use sparingly — prefer `.match()` or `.map()` for railway-oriented programming.
 *
 * @param result - The result to unwrap
 * @returns The contained value
 * @throws OrchestrationError if the result is an error
 */
export function unwrapResult<T>(result: DomainResult<T>): T {
  if (result.isOk()) {
    return result.value;
  }
  throw result.error;
}

/**
 * Unwrap an optional value from a Result, returning a default if error.
 *
 * @param result - The result to unwrap
 * @param defaultValue - The default value to return on error
 * @returns The contained value or the default
 */
export function unwrapOr<T>(result: DomainResult<T>, defaultValue: T): T {
  if (result.isOk()) {
    return result.value;
  }
  return defaultValue;
}

/**
 * Map the error side of a DomainResult to a new error.
 * Useful for adding context to errors as they propagate up.
 *
 * @param result - The result to map
 * @param fn - The mapping function
 * @returns A new DomainResult with the mapped error
 */
export function mapError<T>(
  result: DomainResult<T>,
  fn: (error: OrchestrationError) => OrchestrationError,
): DomainResult<T> {
  return result.mapErr(fn);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Import from errors module to avoid circular dependency
 */
async function importOrchestrationError(): Promise<typeof import('../core/errors.js')> {
  return import('../core/errors.js');
}

/** Cached reference to avoid repeated dynamic imports */
let _OrchestrationErrorClass: typeof OrchestrationError | null = null;

async function getOrchestrationErrorClass(): Promise<typeof OrchestrationError> {
  if (!_OrchestrationErrorClass) {
    const mod = await importOrchestrationError();
    _OrchestrationErrorClass = mod.OrchestrationError;
  }
  return _OrchestrationErrorClass;
}

/**
 * We can't use OrchestrationError directly here because of circular dependency concerns.
 * Instead, we handle the error wrapping dynamically.
 */
function wrapError(error: unknown, defaultMessage: string): OrchestrationError {
  // Check if it's already an OrchestrationError
  if (
    error instanceof Error &&
    'code' in error &&
    'retryable' in error &&
    'toJSON' in error
  ) {
    return error as OrchestrationError;
  }

  // Wrap in a generic OrchestrationError
  const message = error instanceof Error ? error.message : String(error);

  // Create a basic OrchestrationError-like object
  const wrappedError = new Error(`${defaultMessage}: ${message}`) as Error & {
    code: string;
    retryable: boolean;
    toJSON: () => Record<string, unknown>;
    context: Record<string, unknown>;
    timestamp: string;
  };

  // Attach OrchestrationError-like properties
  Object.defineProperties(wrappedError, {
    code: { value: 'UNEXPECTED_ERROR', enumerable: true },
    retryable: { value: false, enumerable: true },
    context: {
      value: {
        originalError: error instanceof Error ? error.message : String(error),
      },
      enumerable: true,
    },
    timestamp: { value: new Date().toISOString(), enumerable: true },
    toJSON: {
      value: function () {
        return {
          name: 'OrchestrationError',
          code: 'UNEXPECTED_ERROR',
          message: this.message,
          retryable: false,
          context: this.context,
          timestamp: this.timestamp,
          stack: this.stack,
        };
      },
      enumerable: true,
    },
  });

  return wrappedError as unknown as OrchestrationError;
}
