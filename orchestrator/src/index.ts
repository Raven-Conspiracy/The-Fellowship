/**
 * =============================================================================
 * The Fellowship Orchestrator — Public API Surface
 * =============================================================================
 *
 * This is the entry point for consumers of the orchestrator (AIP Logic, tests, etc.).
 * All public types and functions are re-exported from this module.
 *
 * Usage:
 * ```typescript
 * import { executeGraph, GraphBuilder, ExecutionStatus } from '@the-fellowship/orchestrator';
 * ```
 */

// ============================================================================
// Core Types
// ============================================================================

export type {
  // Branded types
  AgentName,
  GraphName,
  ExecutionId,
  NodeId,
  IdempotencyKey,
  // Logging
  Logger,
  // Configuration
  AgentNodeConfig,
  AgentNodeDefinition,
  AgentInput,
  AgentOutput,
  AgentResult,
  // Graph
  AgentGraph,
  GraphMetadata,
  GraphState,
  ReadonlyGraphState,
  GraphStateSnapshot,
  NodeCondition,
  InputTransform,
  // Execution
  ExecutionRequest,
  ExecutionResult,
  ExecutionPlan,
  ExecutionLayer,
  NodeTrace,
  ExecutionEvent,
  ExecutionEventListener,
  GraphEventEmitter,
  // Infrastructure
  RetryPolicy,
  CircuitBreakerConfig,
  ApolloConfig,
  FoundryConfig,
  OrchestratorConfig,
  AgentExecutor,
} from './core/types.js';

export {
  // Branded type constructors
  AgentName as createAgentName,
  GraphName as createGraphName,
  ExecutionId as createExecutionId,
  NodeId as createNodeId,
  IdempotencyKey as createIdempotencyKey,
  // Enums
  LogLevel,
  ExecutionStatus,
  ExecutionEventType,
  CircuitBreakerState,
  // Defaults
  DEFAULT_RETRY_POLICY,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  // Type guards
  isAgentName,
  isGraphName,
  isExecutionId,
  isNodeId,
} from './core/types.js';

// ============================================================================
// Errors
// ============================================================================

export {
  OrchestrationError,
  GraphNotFoundError,
  CyclicGraphError,
  InvalidGraphError,
  NodeExecutionError,
  ApolloClientError,
  ApolloAuthenticationError,
  ApolloTimeoutError,
  AgentNotRegisteredError,
  ExecutionTimeoutError,
  IdempotencyConflictError,
  CircuitBreakerOpenError,
  ConfigurationError,
  FoundryWriteError,
  FoundryEventEmitError,
  isRetryableError,
  getErrorCode,
  errorToLoggableObject,
} from './core/errors.js';

// ============================================================================
// Logger
// ============================================================================

export {
  createLogger,
  createLoggerFromEnv,
  noopLogger,
  InMemoryLogger,
} from './core/logger.js';

export type { CreateLoggerOptions, LogEntry } from './core/logger.js';

// ============================================================================
// Graph Module
// ============================================================================

// GraphState
export {
  ImmutableGraphState,
  asReadonly,
  deepFreeze,
} from './graph/graph-state.js';

// AgentNode
export {
  AgentNode,
  createAgentNode,
} from './graph/agent-node.js';

// AgentGraph
export {
  AgentGraphImpl,
} from './graph/agent-graph.js';

// GraphBuilder
export {
  GraphBuilder,
  createGraphBuilder,
} from './graph/graph-builder.js';

export type {
  NodeOptions,
  GraphBuilderOptions,
} from './graph/graph-builder.js';

// GraphRunner
export {
  GraphRunner,
  runGraph,
} from './graph/graph-runner.js';

export type {
  GraphRunnerOptions,
} from './graph/graph-runner.js';

// ============================================================================
// Utilities
// ============================================================================

// Result (neverthrow)
export {
  ok,
  err,
  okAsync,
  errAsync,
  fromPromise,
  fromSafePromise,
  Result,
  ResultAsync,
  safeAsync,
  safeSync,
  combineResults,
  combineAsyncResults,
  unwrapResult,
  unwrapOr,
  mapError,
} from './utils/result.js';

export type {
  DomainResult,
  AsyncDomainResult,
} from './utils/result.js';

// Retry
export {
  withRetry,
  retryable,
  createRetryPolicy,
  isNonRetryableHttpStatus,
  isRetryableHttpStatus,
} from './utils/retry.js';

export type {
  RetryOptions,
} from './utils/retry.js';

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
} from './utils/circuit-breaker.js';

export type {
  CircuitBreakerSnapshot,
} from './utils/circuit-breaker.js';

// Validator
export {
  envVarsSchema,
  yamlConfigSchema,
  executionRequestSchema,
  agentNodeConfigSchema,
  agentNodeDefinitionSchema,
  validateEnvVars,
  validateYamlConfig,
  validateExecutionRequest,
  validateAgentNodeConfig,
  formatZodError,
} from './utils/validator.js';

export type {
  ValidatedEnvVars,
  ValidatedYamlConfig,
} from './utils/validator.js';

// ID Generator
export {
  generateUlid,
  generateExecutionId,
  generateNodeId,
  generateIdempotencyKey,
  generatePrefixedExecutionId,
  generatePrefixedNodeId,
  generateDeterministicIdempotencyKey,
  isValidUlid,
  extractTimestampFromUlid,
  extractRandomFromUlid,
  compareUlids,
  isAfter,
  isBefore,
} from './utils/id-generator.js';

// ============================================================================
// Main Execution Function
// ============================================================================

import type {
  AgentExecutor,
  ExecutionId,
  ExecutionResult,
  Logger,
  GraphEventEmitter,
  AgentGraph,
} from './core/types.js';
import {
  ExecutionStatus,
} from './core/types.js';
import { GraphRunner } from './graph/graph-runner.js';
import type { GraphRunnerOptions } from './graph/graph-runner.js';
import { generateExecutionId } from './utils/id-generator.js';
import { noopLogger } from './core/logger.js';

/**
 * Execute a graph by name (looking it up from a registry).
 * This is the main entry point that AIP Logic calls.
 *
 * @param graph - The graph to execute
 * @param input - The input payload
 * @param agentExecutor - The executor that makes actual agent calls
 * @param options - Additional execution options
 * @returns An ExecutionResult
 *
 * @example
 * ```typescript
 * const result = await executeGraph(triageGraph, { incidentId: "123" }, agentExecutor, {
 *   logger,
 *   maxParallelism: 5,
 * });
 * ```
 */
export async function executeGraph(
  graph: AgentGraph,
  input: Record<string, unknown>,
  agentExecutor: AgentExecutor,
  options?: {
    executionId?: ExecutionId;
    logger?: Logger;
    eventEmitter?: GraphEventEmitter;
    maxParallelism?: number;
    executionTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ExecutionResult> {
  const executionId = options?.executionId ?? generateExecutionId();
  const logger = options?.logger ?? noopLogger;

  logger.info('Executing graph', {
    executionId,
    graphName: graph.name,
    nodeCount: graph.nodes.size,
  });

  const runnerOptions: GraphRunnerOptions = {
    graph,
    agentExecutor,
    logger,
    eventEmitter: options?.eventEmitter,
    maxParallelism: options?.maxParallelism,
    executionTimeoutMs: options?.executionTimeoutMs,
    signal: options?.signal,
  };

  const runner = new GraphRunner(runnerOptions);

  try {
    const result = await runner.execute(executionId, input);

    logger.info('Graph execution completed', {
      executionId,
      graphName: graph.name,
      status: result.status,
      durationMs: result.durationMs,
      completedNodes: result.finalState.completedNodes.length,
      failedNodes: result.finalState.failedNodes.length,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Graph execution threw unhandled error', {
      executionId,
      graphName: graph.name,
      error: message,
    });

    throw error;
  }
}
