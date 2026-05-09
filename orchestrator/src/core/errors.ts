/**
 * =============================================================================
 * Typed Error Hierarchy — The Fellowship Orchestrator
 * =============================================================================
 *
 * Every error in the system extends OrchestrationError.
 * Each error class carries:
 *   - A unique `code` for programmatic handling
 *   - A `retryable` flag for retry decision logic
 *   - A `toJSON()` method for structured logging / serialization
 *
 * This design follows the "railway-oriented" error handling pattern
 * where errors are typed values, not thrown exceptions (though they
 * can be thrown when combined with Result types).
 */

// ============================================================================
// Base Error
// ============================================================================

/**
 * Base class for all orchestration errors.
 * Every domain error MUST extend this class.
 */
export class OrchestrationError extends Error {
  /** Machine-readable error code for programmatic handling */
  public readonly code: string;
  /** Whether this error is retryable */
  public readonly retryable: boolean;
  /** Additional diagnostic context */
  public readonly context: Record<string, unknown>;
  /** Timestamp of error creation (ISO 8601) */
  public readonly timestamp: string;
  /** The underlying cause, if any */
  public readonly cause?: Error;

  /**
   * @param message - Human-readable error message
   * @param code - Machine-readable error code
   * @param options - Additional error options
   */
  constructor(
    message: string,
    code: string,
    options?: {
      retryable?: boolean;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.context = options?.context ?? {};
    this.cause = options?.cause;
    this.timestamp = new Date().toISOString();

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Serialize this error to a JSON-safe object for structured logging.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
      timestamp: this.timestamp,
      cause: this.cause instanceof OrchestrationError ? this.cause.toJSON() : this.cause?.message,
      stack: this.stack,
    };
  }

  /**
   * Create a plain object representation suitable for Foundry datasets.
   */
  toDatasetRow(): Record<string, unknown> {
    return {
      error_name: this.name,
      error_code: this.code,
      error_message: this.message,
      error_retryable: this.retryable,
      error_context: JSON.stringify(this.context),
      error_timestamp: this.timestamp,
      error_cause: this.cause?.message ?? null,
    };
  }
}

// ============================================================================
// Graph Errors
// ============================================================================

/**
 * Thrown when a requested graph is not found in the registry.
 */
export class GraphNotFoundError extends OrchestrationError {
  /** The graph name that was not found */
  public readonly graphName: string;

  constructor(graphName: string, context?: Record<string, unknown>) {
    super(
      `Graph not found: "${graphName}"`,
      'GRAPH_NOT_FOUND',
      {
        retryable: false,
        context: { graphName, ...context },
      },
    );
    this.graphName = graphName;
  }
}

/**
 * Thrown when a graph contains a cycle (is not a valid DAG).
 */
export class CyclicGraphError extends OrchestrationError {
  /** The graph name containing the cycle */
  public readonly graphName: string;
  /** The nodes involved in the cycle */
  public readonly cycleNodes: ReadonlyArray<string>;

  constructor(
    graphName: string,
    cycleNodes: ReadonlyArray<string>,
    context?: Record<string, unknown>,
  ) {
    super(
      `Graph "${graphName}" contains a cycle involving: ${cycleNodes.join(' → ')}`,
      'CYCLIC_GRAPH',
      {
        retryable: false,
        context: { graphName, cycleNodes: [...cycleNodes], ...context },
      },
    );
    this.graphName = graphName;
    this.cycleNodes = cycleNodes;
  }
}

/**
 * Thrown when a graph definition is structurally invalid.
 */
export class InvalidGraphError extends OrchestrationError {
  /** The graph name */
  public readonly graphName: string;
  /** Specific validation errors */
  public readonly validationErrors: ReadonlyArray<string>;

  constructor(
    graphName: string,
    validationErrors: ReadonlyArray<string>,
    context?: Record<string, unknown>,
  ) {
    super(
      `Graph "${graphName}" is invalid: ${validationErrors.join('; ')}`,
      'INVALID_GRAPH',
      {
        retryable: false,
        context: { graphName, validationErrors: [...validationErrors], ...context },
      },
    );
    this.graphName = graphName;
    this.validationErrors = validationErrors;
  }
}

// ============================================================================
// Node Execution Errors
// ============================================================================

/**
 * Thrown when a node execution fails.
 */
export class NodeExecutionError extends OrchestrationError {
  /** The node that failed */
  public readonly nodeName: string;
  /** The agent that was being executed */
  public readonly agentName: string;
  /** The execution ID */
  public readonly executionId: string;
  /** The attempt number that failed */
  public readonly attemptNumber: number;

  constructor(
    message: string,
    nodeName: string,
    agentName: string,
    executionId: string,
    attemptNumber: number,
    options?: {
      retryable?: boolean;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, 'NODE_EXECUTION_ERROR', {
      retryable: options?.retryable ?? true,
      context: {
        nodeName,
        agentName,
        executionId,
        attemptNumber,
        ...options?.context,
      },
      cause: options?.cause,
    });
    this.nodeName = nodeName;
    this.agentName = agentName;
    this.executionId = executionId;
    this.attemptNumber = attemptNumber;
  }
}

// ============================================================================
// Apollo Errors
// ============================================================================

/**
 * Base class for Apollo-related errors.
 */
export class ApolloClientError extends OrchestrationError {
  /** The Apollo endpoint that was called */
  public readonly endpoint: string;
  /** The HTTP status code, if available */
  public readonly statusCode?: number;

  constructor(
    message: string,
    endpoint: string,
    options?: {
      code?: string;
      retryable?: boolean;
      statusCode?: number;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, options?.code ?? 'APOLLO_CLIENT_ERROR', {
      retryable: options?.retryable ?? true,
      context: { endpoint, statusCode: options?.statusCode, ...options?.context },
      cause: options?.cause,
    });
    this.endpoint = endpoint;
    this.statusCode = options?.statusCode;
  }
}

/**
 * Thrown when Apollo authentication fails (401).
 */
export class ApolloAuthenticationError extends ApolloClientError {
  constructor(endpoint: string, context?: Record<string, unknown>) {
    super(
      `Apollo authentication failed for endpoint: ${endpoint}`,
      endpoint,
      {
        code: 'APOLLO_AUTHENTICATION_ERROR',
        retryable: false,
        statusCode: 401,
        context,
      },
    );
  }
}

/**
 * Thrown when an Apollo request times out.
 */
export class ApolloTimeoutError extends ApolloClientError {
  /** The timeout duration that was exceeded (ms) */
  public readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number, context?: Record<string, unknown>) {
    super(
      `Apollo request timed out after ${timeoutMs}ms for endpoint: ${endpoint}`,
      endpoint,
      {
        code: 'APOLLO_TIMEOUT_ERROR',
        retryable: true,
        statusCode: undefined,
        context: { timeoutMs, ...context },
      },
    );
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// Agent Errors
// ============================================================================

/**
 * Thrown when an agent is not found in the registry.
 */
export class AgentNotRegisteredError extends OrchestrationError {
  /** The agent name that was not found */
  public readonly agentName: string;

  constructor(agentName: string, context?: Record<string, unknown>) {
    super(
      `Agent not registered: "${agentName}"`,
      'AGENT_NOT_REGISTERED',
      {
        retryable: false,
        context: { agentName, ...context },
      },
    );
    this.agentName = agentName;
  }
}

// ============================================================================
// Execution Errors
// ============================================================================

/**
 * Thrown when a graph execution exceeds its timeout.
 */
export class ExecutionTimeoutError extends OrchestrationError {
  /** The execution ID */
  public readonly executionId: string;
  /** The timeout duration that was exceeded (ms) */
  public readonly timeoutMs: number;
  /** The graph name */
  public readonly graphName: string;

  constructor(
    executionId: string,
    graphName: string,
    timeoutMs: number,
    context?: Record<string, unknown>,
  ) {
    super(
      `Execution "${executionId}" for graph "${graphName}" timed out after ${timeoutMs}ms`,
      'EXECUTION_TIMEOUT',
      {
        retryable: false,
        context: { executionId, graphName, timeoutMs, ...context },
      },
    );
    this.executionId = executionId;
    this.graphName = graphName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when an idempotency conflict is detected (duplicate execution).
 */
export class IdempotencyConflictError extends OrchestrationError {
  /** The conflicting idempotency key */
  public readonly idempotencyKey: string;
  /** The existing execution ID */
  public readonly existingExecutionId: string;

  constructor(
    idempotencyKey: string,
    existingExecutionId: string,
    context?: Record<string, unknown>,
  ) {
    super(
      `Idempotency conflict: key "${idempotencyKey}" already exists for execution "${existingExecutionId}"`,
      'IDEMPOTENCY_CONFLICT',
      {
        retryable: false,
        context: { idempotencyKey, existingExecutionId, ...context },
      },
    );
    this.idempotencyKey = idempotencyKey;
    this.existingExecutionId = existingExecutionId;
  }
}

// ============================================================================
// Circuit Breaker Errors
// ============================================================================

/**
 * Thrown when a circuit breaker is open and a request is rejected.
 */
export class CircuitBreakerOpenError extends OrchestrationError {
  /** The agent whose circuit is open */
  public readonly agentName: string;
  /** Timestamp when the circuit opened (ISO 8601) */
  public readonly openedAt: string;

  constructor(agentName: string, openedAt: string, context?: Record<string, unknown>) {
    super(
      `${`Circuit breaker is OPEN for agent "${agentName}" since ${openedAt}. Requests are rejected.`}`,
      'CIRCUIT_BREAKER_OPEN',
      {
        retryable: true, // retryable because the circuit may close later
        context: { agentName, openedAt, ...context },
      },
    );
    this.agentName = agentName;
    this.openedAt = openedAt;
  }
}

// ============================================================================
// Configuration Errors
// ============================================================================

/**
 * Thrown when there is a configuration error.
 */
export class ConfigurationError extends OrchestrationError {
  /** The configuration key that caused the error */
  public readonly configKey?: string;

  constructor(
    message: string,
    options?: {
      configKey?: string;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, 'CONFIGURATION_ERROR', {
      retryable: false,
      context: { configKey: options?.configKey, ...options?.context },
    });
    this.configKey = options?.configKey;
  }
}

// ============================================================================
// Foundry Errors
// ============================================================================

/**
 * Thrown when writing to Foundry Ontology fails.
 */
export class FoundryWriteError extends OrchestrationError {
  /** The ontology RID that was written to */
  public readonly ontologyRid: string;
  /** The action type RID */
  public readonly actionTypeRid: string;

  constructor(
    message: string,
    ontologyRid: string,
    actionTypeRid: string,
    options?: {
      retryable?: boolean;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, 'FOUNDRY_WRITE_ERROR', {
      retryable: options?.retryable ?? true,
      context: { ontologyRid, actionTypeRid, ...options?.context },
      cause: options?.cause,
    });
    this.ontologyRid = ontologyRid;
    this.actionTypeRid = actionTypeRid;
  }
}

/**
 * Thrown when emitting an event to Foundry Streams fails.
 */
export class FoundryEventEmitError extends OrchestrationError {
  /** The event stream RID */
  public readonly streamRid: string;
  /** The event type that failed to emit */
  public readonly eventType: string;

  constructor(
    message: string,
    streamRid: string,
    eventType: string,
    options?: {
      retryable?: boolean;
      context?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, 'FOUNDRY_EVENT_EMIT_ERROR', {
      retryable: options?.retryable ?? true,
      context: { streamRid, eventType, ...options?.context },
      cause: options?.cause,
    });
    this.streamRid = streamRid;
    this.eventType = eventType;
  }
}

// ============================================================================
// Error Utilities
// ============================================================================

/**
 * Determine if an error is retryable.
 * Works with both OrchestrationError and generic Error instances.
 *
 * @param error - The error to check
 * @returns true if the error indicates a retryable condition
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof OrchestrationError) {
    return error.retryable;
  }

  // Common retryable patterns for non-Orchestration errors
  const message = error.message.toLowerCase();
  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('enotfound') ||
    message.includes('socket hang up') ||
    message.includes('network error')
  ) {
    return true;
  }

  // Default to non-retryable for unknown errors
  return false;
}

/**
 * Extract the error code from any error.
 *
 * @param error - The error
 * @returns The error code, or 'UNKNOWN_ERROR' if not an OrchestrationError
 */
export function getErrorCode(error: Error): string {
  if (error instanceof OrchestrationError) {
    return error.code;
  }
  return 'UNKNOWN_ERROR';
}

/**
 * Convert any error to a structured loggable object.
 *
 * @param error - The error to convert
 * @returns A JSON-safe object representing the error
 */
export function errorToLoggableObject(error: Error): Record<string, unknown> {
  if (error instanceof OrchestrationError) {
    return error.toJSON();
  }

  return {
    name: error.name,
    message: error.message,
    code: 'UNKNOWN_ERROR',
    retryable: false,
    stack: error.stack,
  };
}
