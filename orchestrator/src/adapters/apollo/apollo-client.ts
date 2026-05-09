/**
 * Apollo HTTP Client
 *
 * Authenticated HTTP client for invoking Striveworks agents via Palantir Apollo.
 * Handles auth token injection, configurable timeout, exponential-backoff retry
 * via axios-retry, and circuit breaker integration to prevent cascading failures.
 *
 * All public methods return `Result<T, OrchestrationError>` using the `neverthrow`
 * pattern so callers handle errors explicitly without try/catch.
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import axiosRetry, { IAxiosRetryConfig } from 'axios-retry';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { ulid } from 'ulid';

import type { Logger } from '../../core/types.js';
import type {
  AgentInput,
  AgentOutput,
  CircuitBreakerConfig,
  RetryPolicy,
} from '../../core/types.js';
import { CircuitBreakerState } from '../../core/types.js';
import {
  OrchestrationError,
  ApolloClientError,
  ApolloAuthenticationError,
  ApolloTimeoutError,
  CircuitBreakerOpenError,
} from '../../core/errors.js';
import { CircuitBreaker } from '../../utils/circuit-breaker.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A request to be sent to an Apollo endpoint. */
export interface ApolloRequest {
  readonly agentRoute: string;
  readonly payload: AgentInput;
  readonly metadata?: Record<string, unknown>;
}

/** The response returned by an Apollo endpoint. */
export interface ApolloResponse {
  readonly status: 'success' | 'error';
  readonly requestId?: string;
  readonly data?: AgentOutput;
  readonly metadata?: Record<string, unknown>;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly detail?: unknown;
  };
}

/** Configuration for connecting to the Apollo service mesh. */
export interface ApolloEndpointConfig {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly circuitBreakerConfig?: CircuitBreakerConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_HALF_OPEN_MAX_REQUESTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRetryableAxiosError(error: AxiosError): boolean {
  if (!error.response) return true;
  const status = error.response.status;
  return status >= 500 || status === 429;
}

function buildHeaders(apiToken: string, correlationId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Correlation-Id': correlationId ?? ulid(),
    'User-Agent': 'The-Fellowship-Orchestrator/0.1.0',
  };
}

// ---------------------------------------------------------------------------
// ApolloClient
// ---------------------------------------------------------------------------

/**
 * Authenticated Apollo HTTP client wrapping axios with retry and circuit breaker.
 */
export class ApolloClient {
  private readonly http: AxiosInstance;
  private readonly breaker: CircuitBreaker;
  private readonly logger: Logger;
  private readonly apiToken: string;
  private readonly baseUrl: string;

  constructor(config: ApolloEndpointConfig, logger: Logger) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiToken = config.apiToken;
    this.logger = logger.child({ component: 'ApolloClient' });

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    // Axios retry
    const maxRetries = config.retryPolicy?.maxAttempts ?? DEFAULT_RETRY_COUNT;
    const baseDelay = config.retryPolicy?.baseDelayMs ?? DEFAULT_BACKOFF_BASE_MS;
    const maxDelay = config.retryPolicy?.maxDelayMs ?? 30_000;
    const multiplier = config.retryPolicy?.backoffMultiplier ?? 2;
    const useJitter = config.retryPolicy?.jitter !== false;

    const retryConfig: IAxiosRetryConfig = {
      retries: maxRetries,
      retryDelay: (retryCount) => {
        const exponential = Math.min(baseDelay * Math.pow(multiplier, retryCount - 1), maxDelay);
        const jittered = useJitter ? exponential * (0.5 + Math.random() * 0.5) : exponential;
        this.logger.debug(
          `Apollo retry backoff: attempt=${retryCount} delay=${Math.round(jittered)}ms`,
        );
        return Math.round(jittered);
      },
      retryCondition: isRetryableAxiosError,
      onRetry: (retryCount, error) => {
        this.logger.warn(
          `Retrying Apollo request: attempt=${retryCount} url=${error.config?.url} status=${error.response?.status}`,
        );
      },
    };
    axiosRetry(this.http, retryConfig);

    // Circuit breaker
    const cbConfig: CircuitBreakerConfig = {
      failureThreshold:
        config.circuitBreakerConfig?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
      cooldownMs: config.circuitBreakerConfig?.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS,
      halfOpenMaxRequests:
        config.circuitBreakerConfig?.halfOpenMaxRequests ?? DEFAULT_HALF_OPEN_MAX_REQUESTS,
    };
    this.breaker = new CircuitBreaker(
      cbConfig,
      this.logger.child({ component: 'CircuitBreaker' }) as any,
    );
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a single Apollo request against a Striveworks agent endpoint.
   */
  async execute(request: ApolloRequest): Promise<Result<ApolloResponse, OrchestrationError>> {
    const correlationId = ulid();

    const axiosConfig: AxiosRequestConfig = {
      method: 'POST',
      url: request.agentRoute,
      data: request.payload,
      headers: buildHeaders(this.apiToken, correlationId),
    };

    this.logger.info(
      `Executing Apollo request: route=${request.agentRoute} correlationId=${correlationId}`,
    );

    try {
      // Use circuit breaker to wrap the call — it records success/failure automatically
      const response = await this.breaker.call<AxiosResponse<ApolloResponse>>(() =>
        this.http.request(axiosConfig),
      );
      this.logger.info(
        `Apollo request succeeded: status=${response.status} route=${request.agentRoute}`,
      );
      return ok(response.data);
    } catch (error: unknown) {
      // CircuitBreakerOpenError is thrown by breaker.call() when circuit is open
      if (error instanceof CircuitBreakerOpenError) {
        this.logger.warn(`Circuit breaker open — request rejected: agent=${request.agentRoute}`);
        return err(error);
      }
      // All other errors: map to typed error; breaker already recorded the failure
      const mapped = this.mapError(error as AxiosError | Error, correlationId, request.agentRoute);
      this.logger.error(
        `Apollo request failed: route=${request.agentRoute} errorType=${mapped.code} message=${mapped.message}`,
      );
      return err(mapped);
    }
  }

  /**
   * Perform a lightweight health check against the Apollo instance.
   */
  async healthCheck(): Promise<Result<boolean, OrchestrationError>> {
    const correlationId = ulid();
    try {
      const response = await this.http.get('/health', {
        headers: buildHeaders(this.apiToken, correlationId),
        timeout: 5_000,
      });
      this.logger.info('Apollo health check OK');
      return ok(true);
    } catch (error: unknown) {
      const mapped = this.mapError(error as AxiosError | Error, correlationId, '/health');
      this.logger.warn(`Apollo health check failed: ${mapped.message}`);
      return err(mapped);
    }
  }

  /** Retrieve the current circuit breaker state for monitoring. */
  getCircuitBreakerState(): CircuitBreakerState {
    return this.breaker.state;
  }

  /** Force the circuit breaker closed (e.g. after manual intervention). */
  resetCircuitBreaker(): void {
    this.breaker.reset();
    this.logger.info('Circuit breaker manually reset');
  }

  // -----------------------------------------------------------------------
  // Error Mapping
  // -----------------------------------------------------------------------

  private mapError(
    error: AxiosError | Error,
    correlationId: string,
    agentRoute: string,
  ): OrchestrationError {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const responseData = error.response?.data as Record<string, unknown> | undefined;

      // Timeout
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return new ApolloTimeoutError(agentRoute, 0, { correlationId, cause: error });
      }

      // Network error (no response)
      if (!error.response) {
        return new ApolloClientError(`Apollo network error: ${error.message}`, agentRoute, {
          code: 'APOLLO_NETWORK_ERROR',
          retryable: true,
          context: { correlationId },
          cause: error,
        });
      }

      // Authentication
      if (status === 401 || status === 403) {
        return new ApolloAuthenticationError(agentRoute, { correlationId, statusCode: status });
      }

      // Rate limiting
      if (status === 429) {
        return new ApolloClientError(`Apollo rate-limited: ${agentRoute}`, agentRoute, {
          code: 'APOLLO_RATE_LIMITED',
          retryable: true,
          statusCode: 429,
          context: { correlationId },
        });
      }

      // Generic HTTP error
      return new ApolloClientError(`Apollo HTTP ${status}: ${error.message}`, agentRoute, {
        code: status && status >= 500 ? 'APOLLO_SERVER_ERROR' : 'APOLLO_CLIENT_ERROR',
        retryable: status != null && status >= 500,
        statusCode: status ?? 0,
        context: { correlationId, responseData },
        cause: error,
      });
    }

    // Non-Axios error
    return new ApolloClientError(`Unexpected Apollo client error: ${error.message}`, agentRoute, {
      context: { correlationId },
      cause: error,
    });
  }
}
