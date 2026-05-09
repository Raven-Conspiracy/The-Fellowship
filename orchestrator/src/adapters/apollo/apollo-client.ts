/**
 * Apollo HTTP Client
 *
 * Authenticated HTTP client for invoking Striveworks agents via Palantir Apollo.
 * Handles auth token injection, configurable timeout, exponential-backoff retry
 * via axios-retry, and circuit breaker integration to prevent cascading failures.
 *
 * All public methods return `AsyncDomainResult<T>` using the `neverthrow` pattern
 * so callers handle errors explicitly without try/catch.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from "axios";
import axiosRetry, { IAxiosRetryConfig } from "axios-retry";
import { err, ok, ResultAsync, errAsync, okAsync } from "neverthrow";
import { ulid } from "ulid";

import type { Logger } from "../../core/logger.js";
import type {
  ApolloRequest,
  ApolloResponse,
  ApolloEndpointConfig,
  CircuitBreakerState,
  RetryPolicy,
} from "../../core/types.js";
import {
  ApolloError,
  NetworkError,
  TimeoutError,
  AuthenticationError,
  CircuitBreakerOpenError,
  DomainError,
} from "../../core/errors.js";
import { CircuitBreaker } from "../../utils/circuit-breaker.js";

// ---------------------------------------------------------------------------
// Re-export for convenience so adapters only need this module
// ---------------------------------------------------------------------------

export type { ApolloRequest, ApolloResponse, ApolloEndpointConfig };

/** Type alias for an async neverthrow Result carrying an ApolloResponse. */
export type AsyncApolloResult = ResultAsync<ApolloResponse, DomainError>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether an Axios error is retryable.
 * Retries on network errors, server errors (5xx), and 429 (rate-limited).
 * Does NOT retry on 4xx (client errors) except 429, nor on success codes.
 */
function isRetryable(error: AxiosError): boolean {
  // Network / timeout — no response at all
  if (!error.response) {
    return true;
  }
  const status = error.response.status;
  // Retry on server errors and rate-limiting
  return status >= 500 || status === 429;
}

/**
 * Build a standard set of headers for every Apollo request.
 */
function buildHeaders(apiToken: string, correlationId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Correlation-Id": correlationId ?? ulid(),
    "User-Agent": "The-Fellowship-Orchestrator/0.1.0",
  };
}

// ---------------------------------------------------------------------------
// ApolloClient
// ---------------------------------------------------------------------------

/**
 * Authenticated Apollo HTTP client.
 *
 * Wraps an `axios` instance with:
 * - Bearer-token auth on every request
 * - Exponential-backoff retry (via `axios-retry`)
 * - Per-endpoint timeouts
 * - Circuit breaker guarding the upstream
 */
export class ApolloClient {
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker;
  private readonly logger: Logger;
  private readonly apiToken: string;
  private readonly baseUrl: string;

  /**
   * @param config  - Endpoint configuration (base URL, token, timeouts, retry policy)
   * @param logger  - Structured logger instance
   */
  constructor(config: ApolloEndpointConfig, logger: Logger) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, ""); // strip trailing slashes
    this.apiToken = config.apiToken;
    this.logger = logger.child({ component: "ApolloClient" });

    // -- Axios instance --------------------------------------------------
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // -- Axios retry -----------------------------------------------------
    const retryConfig: IAxiosRetryConfig = {
      retries: config.retryPolicy?.maxAttempts ?? DEFAULT_RETRY_COUNT,
      retryDelay: (retryCount, error) => {
        const base = config.retryPolicy?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
        const delay = Math.min(base * Math.pow(2, retryCount - 1), 30_000);
        const jitter = delay * (0.5 + Math.random() * 0.5);
        this.logger.debug({ retryCount, delay: Math.round(jitter) }, "Apollo retry backoff");
        return Math.round(jitter);
      },
      retryCondition: isRetryable,
      onRetry: (retryCount, error) => {
        this.logger.warn(
          { retryCount, url: error.config?.url, status: error.response?.status },
          "Retrying Apollo request",
        );
      },
    };
    axiosRetry(this.http, retryConfig);

    // -- Circuit breaker -------------------------------------------------
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
      resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_MS,
      logger: this.logger.child({ component: "CircuitBreaker" }),
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a single Apollo request against a Striveworks agent endpoint.
   *
   * @param request - The ApolloRequest containing the agent route and payload.
   * @returns An `AsyncApolloResult` wrapping the deserialized ApolloResponse or a DomainError.
   */
  async execute(request: ApolloRequest): AsyncApolloResult {
    const correlationId = ulid();

    // -- Circuit breaker guard --------------------------------------------
    if (this.breaker.isOpen()) {
      this.logger.warn({ correlationId, agent: request.agentRoute }, "Circuit breaker open — request rejected");
      return errAsync(
        new CircuitBreakerOpenError("Circuit breaker is open — upstream unavailable", {
          agentRoute: request.agentRoute,
        }),
      );
    }

    const axiosConfig: AxiosRequestConfig = {
      method: "POST",
      url: request.agentRoute,
      data: request.payload,
      headers: buildHeaders(this.apiToken, correlationId),
    };

    this.logger.info(
      { correlationId, agentRoute: request.agentRoute },
      "Executing Apollo request",
    );

    try {
      const response: AxiosResponse<ApolloResponse> = await this.http.request(axiosConfig);

      // Record success in circuit breaker
      this.breaker.recordSuccess();

      this.logger.info(
        { correlationId, status: response.status, agentRoute: request.agentRoute },
        "Apollo request succeeded",
      );

      return ok(response.data);
    } catch (error: unknown) {
      return this.handleError(error as AxiosError | Error, correlationId, request.agentRoute);
    }
  }

  /**
   * Perform a lightweight health check against the Apollo instance.
   *
   * @returns `ok(true)` if Apollo responds within the health-check window,
   *          or an `err(DomainError)` otherwise.
   */
  async healthCheck(): ResultAsync<boolean, DomainError> {
    const correlationId = ulid();

    try {
      const response = await this.http.get("/health", {
        headers: buildHeaders(this.apiToken, correlationId),
        timeout: 5_000,
      });
      this.logger.info({ correlationId, status: response.status }, "Apollo health check OK");
      return ok(true);
    } catch (error: unknown) {
      const mapped = this.mapAxiosError(error as AxiosError | Error, correlationId, "/health");
      this.logger.warn({ correlationId, err: mapped }, "Apollo health check failed");
      return err(mapped);
    }
  }

  /**
   * Retrieve the current circuit breaker state for monitoring.
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return this.breaker.getState();
  }

  /**
   * Force the circuit breaker closed (e.g. after manual intervention).
   */
  resetCircuitBreaker(): void {
    this.breaker.reset();
    this.logger.info("Circuit breaker manually reset");
  }

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  /**
   * Map an Axios (or generic) error into a typed `DomainError`.
   */
  private handleError(
    error: AxiosError | Error,
    correlationId: string,
    agentRoute: string,
  ): ReturnType<typeof errAsync<ApolloResponse, DomainError>> {
    const mapped = this.mapAxiosError(error, correlationId, agentRoute);

    // Record failure in circuit breaker
    this.breaker.recordFailure();

    this.logger.error(
      { correlationId, agentRoute, errorType: mapped.code, message: mapped.message },
      "Apollo request failed",
    );

    return errAsync(mapped);
  }

  /**
   * Low-level mapping from AxiosError / Error → DomainError hierarchy.
   */
  private mapAxiosError(error: AxiosError | Error, correlationId: string, agentRoute: string): DomainError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const responseData = error.response?.data as Record<string, unknown> | undefined;

      if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
        return new TimeoutError(`Apollo request timed out: ${agentRoute}`, {
          agentRoute,
          correlationId,
          cause: error,
        });
      }

      if (!error.response) {
        return new NetworkError(`Apollo network error: ${error.message}`, {
          agentRoute,
          correlationId,
          cause: error,
        });
      }

      if (status === 401 || status === 403) {
        return new AuthenticationError(`Apollo authentication failed (HTTP ${status})`, {
          agentRoute,
          correlationId,
          status,
          detail: responseData,
        });
      }

      if (status === 422) {
        return new ApolloError(
          `Apollo validation error: ${(responseData as any)?.message ?? "Unknown validation error"}`,
          {
            agentRoute,
            correlationId,
            status: 422,
            detail: responseData,
            retryable: false,
          },
        );
      }

      if (status === 429) {
        return new ApolloError(`Apollo rate-limited: ${agentRoute}`, {
          agentRoute,
          correlationId,
          status: 429,
          detail: responseData,
          retryable: true,
        });
      }

      // Generic 4xx / 5xx
      return new ApolloError(
        `Apollo HTTP ${status}: ${error.message}`,
        {
          agentRoute,
          correlationId,
          status: status ?? 0,
          detail: responseData,
          retryable: status != null && status >= 500,
          cause: error,
        },
      );
    }

    // Non-Axios error (should be rare)
    return new ApolloError(`Unexpected Apollo client error: ${error.message}`, {
      agentRoute,
      correlationId,
      cause: error,
    });
  }
}
