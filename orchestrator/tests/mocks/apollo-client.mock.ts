/**
 * Apollo Client Mock
 *
 * Mock implementation of `ApolloClient` for unit tests. Returns
 * pre-programmed responses so tests never make real HTTP calls.
 *
 * ## Usage
 *
 * ```typescript
 * import { mockApolloClient } from "../../mocks/apollo-client.mock.js";
 *
 * const mockClient = mockApolloClient();
 * mockClient.setNextResponse(ok(successResponse));
 * // ... test code that calls mockClient.execute()
 * ```
 */

import { vi } from "vitest";
import { ok, err } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";

import type {
  ApolloRequest,
  ApolloResponse,
  CircuitBreakerState,
} from "../../src/core/types.js";
import {
  DomainError,
  ApolloError,
  NetworkError,
  TimeoutError,
} from "../../src/core/errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MockApolloClient {
  execute: ReturnType<typeof vi.fn>;
  healthCheck: ReturnType<typeof vi.fn>;
  getCircuitBreakerState: ReturnType<typeof vi.fn>;
  resetCircuitBreaker: ReturnType<typeof vi.fn>;

  /** Program the next response for `execute()` */
  setNextResponse: (response: Result<ApolloResponse, DomainError>) => void;
  /** Program a sequence of responses (one per call) */
  setResponseSequence: (responses: Result<ApolloResponse, DomainError>[]) => void;
  /** Get all requests that were passed to `execute()` */
  getRequests: () => ApolloRequest[];
  /** Reset all mock state */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully mocked `ApolloClient` for unit testing.
 *
 * The returned object mimics the public API of `ApolloClient` but every
 * method is a Vitest mock function. Use `setNextResponse()` to program
 * what `execute()` returns on the next call.
 */
export function createMockApolloClient(): MockApolloClient {
  let nextResponses: Result<ApolloResponse, DomainError>[] = [];
  const requests: ApolloRequest[] = [];

  const execute = vi.fn(async (request: ApolloRequest) => {
    requests.push(request);
    const response = nextResponses.shift();
    if (!response) {
      return err(
        new ApolloError("Mock: no response programmed — call setNextResponse() first", {
          agentRoute: request.agentRoute,
        }),
      );
    }
    return response;
  });

  const healthCheck = vi.fn(async (): Promise<Result<boolean, DomainError>> => {
    return ok(true);
  });

  const getCircuitBreakerState = vi.fn((): CircuitBreakerState => {
    return { state: "CLOSED", failureCount: 0, lastFailureTime: null };
  });

  const resetCircuitBreaker = vi.fn();

  return {
    execute,
    healthCheck,
    getCircuitBreakerState,
    resetCircuitBreaker,

    setNextResponse(response: Result<ApolloResponse, DomainError>) {
      nextResponses = [response];
    },

    setResponseSequence(responses: Result<ApolloResponse, DomainError>[]) {
      nextResponses = [...responses];
    },

    getRequests() {
      return [...requests];
    },

    reset() {
      nextResponses = [];
      requests.length = 0;
      execute.mockClear();
      healthCheck.mockClear();
      getCircuitBreakerState.mockClear();
      resetCircuitBreaker.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Pre-built response factories
// ---------------------------------------------------------------------------

/**
 * Create a successful `ApolloResponse` for testing.
 */
export function createSuccessResponse(
  overrides: Partial<ApolloResponse> = {},
): ApolloResponse {
  return {
    status: "success",
    requestId: overrides.requestId ?? "ap-req-test-001",
    data: overrides.data ?? {
      result: "mock-success",
      confidence: 0.95,
    },
    metadata: overrides.metadata ?? {
      model_version: "test-v1.0",
      inference_time_ms: 100,
    },
  };
}

/**
 * Create an error `ApolloResponse` for testing.
 */
export function createErrorResponse(
  overrides: Partial<ApolloResponse> = {},
): ApolloResponse {
  return {
    status: "error",
    requestId: overrides.requestId ?? "ap-req-test-err",
    data: overrides.data ?? {},
    error: overrides.error ?? {
      code: "TEST_ERROR",
      message: "Mock agent error for testing",
    },
  };
}

/**
 * Create a pre-built `ok(ApolloResponse)` Result.
 */
export function okResponse(overrides?: Partial<ApolloResponse>): Result<ApolloResponse, DomainError> {
  return ok(createSuccessResponse(overrides));
}

/**
 * Create a pre-built `err(DomainError)` Result.
 */
export function errResponse(
  error?: DomainError,
): Result<ApolloResponse, DomainError> {
  return err(
    error ??
      new ApolloError("Mock Apollo error", {
        agentRoute: "/test",
        retryable: true,
      }),
  );
}

/**
 * Create a `NetworkError` Result for testing retry logic.
 */
export function networkErrorResponse(): Result<ApolloResponse, DomainError> {
  return err(new NetworkError("Mock network error", { agentRoute: "/test" }));
}

/**
 * Create a `TimeoutError` Result for testing timeout handling.
 */
export function timeoutErrorResponse(): Result<ApolloResponse, DomainError> {
  return err(new TimeoutError("Mock timeout", { agentRoute: "/test" }));
}
