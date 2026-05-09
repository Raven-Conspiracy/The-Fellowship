/**
 * Agent Executor
 *
 * Executes a single agent node call end-to-end, integrating:
 * - `AgentRegistry` for endpoint lookup
 * - `ApolloAdapter` for HTTP transport
 * - `RetryPolicy` for exponential-backoff retry
 * - `CircuitBreaker` for upstream protection
 *
 * This is the **only** place that combines registry lookups with actual
 * agent invocation. Graph execution delegates to this class for each node.
 *
 * ## Error Handling
 *
 * All methods return `AsyncDomainResult<T>` (a `Promise<Result<T, DomainError>>`).
 * Errors are never thrown — callers must explicitly handle the error path.
 *
 * ## Retry Logic
 *
 * - Retries are per-node, governed by the `RetryPolicy` on the agent's config
 * - Exponential backoff with jitter is applied between attempts
 * - Non-retryable errors (e.g., schema validation failures) skip retry
 * - The circuit breaker gates the very first attempt
 */

import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { ulid } from "ulid";

import type { Logger } from "../core/logger.js";
import type {
  AgentName,
  AgentNode,
  AgentResult,
  GraphState,
  RetryPolicy,
  AgentEndpointConfig,
  CircuitBreakerState,
} from "../core/types.js";
import {
  DomainError,
  AgentExecutionError,
  AgentTimeoutError,
  CircuitBreakerOpenError,
  AgentRegistryError,
} from "../core/errors.js";
import { AgentRegistry } from "./agent-registry.js";
import { ApolloAdapter } from "../adapters/apollo/apollo-adapter.js";
import type { ApolloEndpointConfig } from "../adapters/apollo/apollo-adapter.js";
import { calculateBackoff } from "../utils/retry.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// AgentExecutor
// ---------------------------------------------------------------------------

/**
 * Executes a single agent node by resolving its endpoint via
 * `AgentRegistry`, invoking the agent via `ApolloAdapter`, and applying
 * retry and circuit breaker policies.
 */
export class AgentExecutor {
  private readonly registry: AgentRegistry;
  private readonly adapter: ApolloAdapter;
  private readonly logger: Logger;

  /**
   * @param registry      - The agent registry for endpoint lookup
   * @param apolloConfig  - Apollo HTTP configuration (shared across all agents)
   * @param logger        - Structured logger
   */
  constructor(
    registry: AgentRegistry,
    apolloConfig: ApolloEndpointConfig,
    logger: Logger,
  ) {
    this.registry = registry;
    this.logger = logger.child({ component: "AgentExecutor" });
    this.adapter = new ApolloAdapter(apolloConfig, this.logger);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a single agent node.
   *
   * The flow:
   * 1. Look up the agent's endpoint configuration from the registry
   * 2. Apply the agent's retry policy (if configured)
   * 3. Attempt execution through `ApolloAdapter`
   * 4. On retryable failure, back off and retry up to `maxAttempts`
   * 5. On success or non-retryable failure, return immediately
   *
   * @param node  - The agent node to execute
   * @param state - The current graph state
   * @returns `ok(AgentResult)` on success, `err(DomainError)` on failure
   */
  async execute(node: AgentNode, state: GraphState): Promise<Result<AgentResult, DomainError>> {
    const executionId = ulid();

    // 1. Resolve the agent's endpoint configuration
    const endpointResult = this.registry.get(node.config.agentName);
    if (endpointResult.isErr()) {
      this.logger.error(
        { executionId, nodeId: node.id, agentName: node.config.agentName },
        "Agent not found in registry",
      );
      return err(endpointResult.error);
    }

    const endpoint = endpointResult.value;
    const retryPolicy = this.resolveRetryPolicy(node.config, endpoint);

    this.logger.info(
      {
        executionId,
        nodeId: node.id,
        agentName: node.config.agentName,
        maxAttempts: retryPolicy.maxAttempts,
      },
      "Executing agent node",
    );

    // 2. Attempt execution with retry
    return this.executeWithRetry(node, state, retryPolicy, executionId);
  }

  /**
   * Check whether a given agent is reachable by performing a lightweight
   * lookup + health check.
   *
   * @param agentName - The logical agent name
   * @returns `ok(true)` if the agent is registered and Apollo is healthy
   */
  async isAgentReachable(agentName: AgentName): Promise<Result<boolean, DomainError>> {
    const endpointResult = this.registry.get(agentName);
    if (endpointResult.isErr()) {
      return err(endpointResult.error);
    }

    const healthResult = await this.adapter.healthCheck();
    if (healthResult.isErr()) {
      return err(healthResult.error);
    }

    return ok(true);
  }

  /**
   * Expose the current circuit breaker state for monitoring.
   */
  getCircuitBreakerState(): CircuitBreakerState {
    return this.adapter.getClient().getCircuitBreakerState();
  }

  /**
   * Expose the underlying adapter (for testing or advanced use).
   */
  getAdapter(): ApolloAdapter {
    return this.adapter;
  }

  // -----------------------------------------------------------------------
  // Retry Logic
  // -----------------------------------------------------------------------

  /**
   * Execute a node with exponential-backoff retry.
   *
   * @param node        - The agent node
   * @param state       - The current graph state
   * @param retryPolicy - Resolved retry policy
   * @param executionId - Correlation ID for this execution attempt
   */
  private async executeWithRetry(
    node: AgentNode,
    state: GraphState,
    retryPolicy: RetryPolicy,
    executionId: string,
  ): Promise<Result<AgentResult, DomainError>> {
    let lastError: DomainError | null = null;
    const startTime = Date.now();

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      this.logger.debug(
        { executionId, nodeId: node.id, attempt, maxAttempts: retryPolicy.maxAttempts },
        "Agent execution attempt",
      );

      const result = await this.adapter.executeNode(node, state);

      if (result.isOk()) {
        const durationMs = Date.now() - startTime;
        const agentResult = result.value;

        // Attach timing metadata
        agentResult.metadata = {
          ...agentResult.metadata,
          durationMs,
          attempts: attempt,
          executionId,
        };

        this.logger.info(
          {
            executionId,
            nodeId: node.id,
            agentName: node.config.agentName,
            attempt,
            durationMs,
          },
          "Agent node executed successfully",
        );

        return ok(agentResult);
      }

      lastError = result.error;

      // If the error is not retryable, fail immediately
      if (!isRetryableError(lastError)) {
        this.logger.warn(
          {
            executionId,
            nodeId: node.id,
            agentName: node.config.agentName,
            errorCode: lastError.code,
          },
          "Non-retryable error — failing immediately",
        );
        return err(lastError);
      }

      // If this was the last attempt, fail
      if (attempt >= retryPolicy.maxAttempts) {
        this.logger.error(
          {
            executionId,
            nodeId: node.id,
            agentName: node.config.agentName,
            attempts: attempt,
            errorCode: lastError.code,
          },
          "All retry attempts exhausted",
        );
        return err(
          new AgentExecutionError(
            `Agent "${node.config.agentName}" failed after ${attempt} attempts: ${lastError.message}`,
            {
              nodeId: node.id,
              agentName: node.config.agentName,
              attempts: attempt,
              cause: lastError,
            },
          ),
        );
      }

      // Calculate backoff and wait
      const delayMs = calculateBackoff(attempt, retryPolicy.backoffBaseMs, retryPolicy.maxBackoffMs);
      this.logger.debug(
        { executionId, nodeId: node.id, attempt, delayMs },
        "Backing off before retry",
      );
      await sleep(delayMs);
    }

    // Should never reach here, but TypeScript needs it
    return err(
      new AgentExecutionError(
        `Agent "${node.config.agentName}" failed after ${retryPolicy.maxAttempts} attempts`,
        {
          nodeId: node.id,
          agentName: node.config.agentName,
          cause: lastError ?? undefined,
        },
      ),
    );
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the effective retry policy for a node by merging node-level
   * overrides with the agent endpoint defaults.
   */
  private resolveRetryPolicy(
    nodeConfig: AgentNodeConfig,
    endpoint: AgentEndpointConfig,
  ): RetryPolicy {
    return {
      maxAttempts:
        nodeConfig.retryPolicy?.maxAttempts ??
        endpoint.maxRetries ??
        DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs:
        nodeConfig.retryPolicy?.backoffBaseMs ??
        endpoint.backoffBaseMs ??
        DEFAULT_BACKOFF_BASE_MS,
      maxBackoffMs:
        nodeConfig.retryPolicy?.maxBackoffMs ??
        DEFAULT_MAX_BACKOFF_MS,
    };
  }
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

/**
 * Determine whether a domain error is retryable.
 *
 * Retryable errors are typically transient:
 * - Network errors (DNS, connection refused)
 * - Timeout errors (upstream slow)
 * - Rate-limiting (HTTP 429)
 * - Circuit breaker open (may have recovered by next attempt)
 * - Server errors (HTTP 5xx)
 *
 * Non-retryable errors:
 * - Authentication errors (bad token)
 * - Schema validation errors (bad payload)
 * - Agent not found in registry
 */
function isRetryableError(error: DomainError): boolean {
  // Explicit retryable flag from ApolloError or similar
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;

  // Heuristic: certain error types are retryable by nature
  const retryableCodes = new Set([
    "NETWORK_ERROR",
    "TIMEOUT_ERROR",
    "APOLLO_TIMEOUT",
    "CIRCUIT_BREAKER_OPEN",
    "FOUNDRY_STREAM_ERROR",
    "APOLLO_ERROR", // Only some ApolloErrors — check the retryable flag
  ]);

  if (retryableCodes.has(error.code)) return true;

  // Non-retryable codes
  const nonRetryableCodes = new Set([
    "AUTHENTICATION_ERROR",
    "APOLLO_ADAPTER_ERROR",
    "AGENT_REGISTRY_ERROR",
    "AGENT_EXECUTION_ERROR",
    "FOUNDRY_AUTH_ERROR",
    "FOUNDRY_WRITE_ERROR",
    "GRAPH_VALIDATION_ERROR",
    "GRAPH_CYCLE_ERROR",
    "INVALID_STATE_TRANSITION",
  ]);

  if (nonRetryableCodes.has(error.code)) return false;

  // Default: retry on unknown errors (conservative)
  return true;
}

// ---------------------------------------------------------------------------
// AgentNodeConfig type (imported but referenced here for clarity)
// ---------------------------------------------------------------------------

import type { AgentNodeConfig } from "../core/types.js";

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep for retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
