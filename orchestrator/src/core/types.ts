/**
 * =============================================================================
 * Core Types & Contracts — The Fellowship Orchestrator
 * =============================================================================
 *
 * This module defines ALL shared types for the orchestration engine.
 * Every type is designed for immutability, traceability, and type-safety.
 *
 * Branded types prevent accidental mixing of semantically different string IDs.
 * Readonly interfaces enforce immutability throughout the system.
 */

// ============================================================================
// Branded Types
// ============================================================================

/**
 * Brand utility type — creates a nominal (branded) type from a base type.
 * Prevents accidental interchange of semantically distinct identifiers.
 */
declare const BRAND: unique symbol;
type Brand<T, BrandTag extends string> = T & { readonly [BRAND]: BrandTag };

/**
 * Logical name of a Striveworks agent (e.g., "classifier", "analyzer").
 */
export type AgentName = Brand<string, 'AgentName'>;

/**
 * Logical name of an AgentGraph (e.g., "incident-triage").
 */
export type GraphName = Brand<string, 'GraphName'>;

/**
 * Unique identifier for a single graph execution run.
 * Uses ULID for time-sortable, URL-safe tracing.
 */
export type ExecutionId = Brand<string, 'ExecutionId'>;

/**
 * Unique identifier for a node within a graph execution.
 * Used for tracing individual node executions.
 */
export type NodeId = Brand<string, 'NodeId'>;

/**
 * Unique identifier for an idempotency key.
 * Prevents duplicate execution of the same request.
 */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;

// ============================================================================
// Constructor Functions for Branded Types
// ============================================================================

/**
 * Creates an AgentName from a string, validating it is non-empty.
 * @param value - The raw agent name string
 * @returns A branded AgentName
 * @throws {ConfigurationError} if value is empty
 */
export function AgentName(value: string): AgentName {
  if (!value || value.trim().length === 0) {
    throw new Error('AgentName must be a non-empty string');
  }
  return value as unknown as AgentName;
}

/**
 * Creates a GraphName from a string, validating it is non-empty.
 * @param value - The raw graph name string
 * @returns A branded GraphName
 * @throws {ConfigurationError} if value is empty
 */
export function GraphName(value: string): GraphName {
  if (!value || value.trim().length === 0) {
    throw new Error('GraphName must be a non-empty string');
  }
  return value as unknown as GraphName;
}

/**
 * Creates an ExecutionId from a string, validating it is non-empty.
 * @param value - The raw execution ID string (typically a ULID)
 * @returns A branded ExecutionId
 * @throws {ConfigurationError} if value is empty
 */
export function ExecutionId(value: string): ExecutionId {
  if (!value || value.trim().length === 0) {
    throw new Error('ExecutionId must be a non-empty string');
  }
  return value as unknown as ExecutionId;
}

/**
 * Creates a NodeId from a string, validating it is non-empty.
 * @param value - The raw node ID string (typically a ULID)
 * @returns A branded NodeId
 * @throws {ConfigurationError} if value is empty
 */
export function NodeId(value: string): NodeId {
  if (!value || value.trim().length === 0) {
    throw new Error('NodeId must be a non-empty string');
  }
  return value as unknown as NodeId;
}

/**
 * Creates an IdempotencyKey from a string, validating it is non-empty.
 * @param value - The raw idempotency key string
 * @returns A branded IdempotencyKey
 * @throws {ConfigurationError} if value is empty
 */
export function IdempotencyKey(value: string): IdempotencyKey {
  if (!value || value.trim().length === 0) {
    throw new Error('IdempotencyKey must be a non-empty string');
  }
  return value as unknown as IdempotencyKey;
}

// ============================================================================
// Logging
// ============================================================================

/**
 * Log levels supported by the orchestrator.
 * Ordered by increasing severity.
 */
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

/**
 * Structured logger interface.
 * All implementations must support these methods.
 */
export interface Logger {
  /** Log at DEBUG level */
  debug(message: string, context?: Record<string, unknown>): void;
  /** Log at INFO level */
  info(message: string, context?: Record<string, unknown>): void;
  /** Log at WARN level */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Log at ERROR level */
  error(message: string, context?: Record<string, unknown>): void;
  /** Create a child logger with additional bound context */
  child(bindings: Record<string, unknown>): Logger;
  /** Get the current log level */
  readonly level: LogLevel;
}

// ============================================================================
// Retry & Circuit Breaker
// ============================================================================

/**
 * Retry policy configuration for an agent or operation.
 */
export interface RetryPolicy {
  /** Maximum number of attempts (including the initial call) */
  readonly maxAttempts: number;
  /** Base delay between retries in milliseconds */
  readonly baseDelayMs: number;
  /** Maximum delay cap in milliseconds */
  readonly maxDelayMs: number;
  /** Multiplier for exponential backoff (e.g., 2 = doubles each attempt) */
  readonly backoffMultiplier: number;
  /** Whether to add random jitter to delay */
  readonly jitter: boolean;
}

/**
 * Default retry policy used when none is specified.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Circuit breaker states.
 */
export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit breaker configuration.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit */
  readonly failureThreshold: number;
  /** Cooldown period before transitioning to HALF_OPEN (ms) */
  readonly cooldownMs: number;
  /** Maximum requests allowed in HALF_OPEN state before re-opening */
  readonly halfOpenMaxRequests: number;
}

/**
 * Default circuit breaker configuration.
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxRequests: 3,
};

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Input payload for an agent execution.
 * The shape varies by agent; this is the raw JSON-encodable input.
 */
export type AgentInput = Record<string, unknown>;

/**
 * Output payload from an agent execution.
 * The shape varies by agent; this is the raw JSON-encodable output.
 */
export type AgentOutput = Record<string, unknown>;

/**
 * Configuration for a single agent node.
 */
export interface AgentNodeConfig {
  /** Logical name of the agent in the registry */
  readonly agentName: AgentName;
  /** Human-readable display name */
  readonly displayName: string;
  /** Apollo route path for this agent */
  readonly apolloRoute: string;
  /** HTTP method for the Apollo call */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** Version of the input schema */
  readonly inputSchemaVersion: string;
  /** Agent-specific timeout in milliseconds */
  readonly timeoutMs: number;
  /** Agent-specific retry policy (overrides global) */
  readonly retryPolicy: RetryPolicy;
  /** Agent-specific circuit breaker config (overrides global) */
  readonly circuitBreakerConfig: CircuitBreakerConfig;
}

/**
 * Result of executing a single agent.
 */
export interface AgentResult {
  /** The node that produced this result */
  readonly nodeId: NodeId;
  /** The agent that was executed */
  readonly agentName: AgentName;
  /** The raw output from the agent */
  readonly output: AgentOutput;
  /** Execution duration in milliseconds */
  readonly durationMs: number;
  /** Number of retry attempts made */
  readonly retryCount: number;
  /** Timestamp of execution start (ISO 8601) */
  readonly startedAt: string;
  /** Timestamp of execution completion (ISO 8601) */
  readonly completedAt: string;
  /** Whether the execution succeeded */
  readonly success: boolean;
  /** Error message if execution failed */
  readonly errorMessage?: string;
}

// ============================================================================
// Graph Types
// ============================================================================

/**
 * A condition function that determines whether a dependent node should execute.
 * Receives the current state and returns true if the node should run.
 */
export type NodeCondition = (state: ReadonlyGraphState) => boolean;

/**
 * A transform function that prepares input for a dependent node.
 * Receives the current state and returns the input for the node.
 */
export type InputTransform = (state: ReadonlyGraphState) => AgentInput;

/**
 * Definition of a node within an AgentGraph.
 */
export interface AgentNodeDefinition {
  /** Unique logical name for this node within the graph */
  readonly name: string;
  /** The agent configuration for this node */
  readonly config: AgentNodeConfig;
  /** Names of nodes that must complete before this node runs */
  readonly dependsOn: ReadonlyArray<string>;
  /** Optional condition — if false, this node is skipped */
  readonly condition?: NodeCondition;
  /** Optional input transform — if provided, overrides default input mapping */
  readonly inputTransform?: InputTransform;
  /** Optional timeout override for this specific node */
  readonly timeoutMs?: number;
  /** Optional retry policy override for this specific node */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Metadata describing a registered AgentGraph.
 */
export interface GraphMetadata {
  /** Logical name of the graph */
  readonly name: GraphName;
  /** Human-readable description */
  readonly description: string;
  /** Version of the graph definition */
  readonly version: string;
  /** When the graph was created (ISO 8601) */
  readonly createdAt: string;
  /** When the graph was last updated (ISO 8601) */
  readonly updatedAt: string;
  /** Tags for categorization and discovery */
  readonly tags: ReadonlyArray<string>;
  /** Owner team or individual */
  readonly owner: string;
  /** Schema that the input payload must conform to (JSON Schema) */
  readonly inputSchema?: Record<string, unknown>;
}

// ============================================================================
// GraphState
// ============================================================================

/**
 * A read-only snapshot of the graph state at a point in time.
 * Used for checkpoints and replay.
 */
export interface GraphStateSnapshot {
  /** The execution this snapshot belongs to */
  readonly executionId: ExecutionId;
  /** The graph this snapshot is for */
  readonly graphName: GraphName;
  /** Node outputs keyed by node name */
  readonly nodeOutputs: Readonly<Record<string, AgentResult>>;
  /** Nodes that have completed execution */
  readonly completedNodes: ReadonlyArray<string>;
  /** Nodes that failed execution */
  readonly failedNodes: ReadonlyArray<string>;
  /** Nodes that were skipped (condition returned false) */
  readonly skippedNodes: ReadonlyArray<string>;
  /** Arbitrary data carried through the graph */
  readonly context: Readonly<Record<string, unknown>>;
  /** Timestamp when this snapshot was taken (ISO 8601) */
  readonly snapshotAt: string;
  /** Monotonically increasing version number */
  readonly version: number;
}

/**
 * Read-only view of the shared typed state bag that flows through a graph.
 *
 * GraphState is the communication mechanism between nodes. Nodes read from state
 * and write their results into state. Nodes are never directly aware of each
 * other — they communicate only through state.
 */
export interface ReadonlyGraphState {
  /** Get the result produced by a specific node */
  get(nodeName: string): AgentResult | undefined;
  /** Check if a node has completed execution */
  has(nodeName: string): boolean;
  /** Get all completed node names */
  completedNodes(): ReadonlyArray<string>;
  /** Get all failed node names */
  failedNodes(): ReadonlyArray<string>;
  /** Get all skipped node names */
  skippedNodes(): ReadonlyArray<string>;
  /** Get the execution ID */
  readonly executionId: ExecutionId;
  /** Get the graph name */
  readonly graphName: GraphName;
  /** Get the initial input payload */
  readonly input: AgentInput;
  /** Get arbitrary context data */
  getContext<T = unknown>(key: string): T | undefined;
  /** Get the snapshot version number */
  readonly version: number;
  /** Convert to a JSON-safe snapshot */
  toJSON(): GraphStateSnapshot;
}

/**
 * Mutable (but immutable-by-convention) shared state bag for graph execution.
 *
 * IMPORTANT: Every `set()` method returns a NEW GraphState instance.
 * The original instance is NEVER mutated. This enables checkpoint/replay
 * and makes the execution fully auditable.
 */
export interface GraphState extends ReadonlyGraphState {
  /**
   * Record the result of a node execution.
   * Returns a NEW GraphState with the result added — the original is unchanged.
   */
  set(nodeName: string, result: AgentResult): GraphState;
  /**
   * Mark a node as failed.
   * Returns a NEW GraphState with the node marked as failed.
   */
  markFailed(nodeName: string, errorMessage: string): GraphState;
  /**
   * Mark a node as skipped.
   * Returns a NEW GraphState with the node marked as skipped.
   */
  markSkipped(nodeName: string): GraphState;
  /**
   * Set arbitrary context data.
   * Returns a NEW GraphState with the context updated.
   */
  setContext(key: string, value: unknown): GraphState;
  /**
   * Create a snapshot of the current state for checkpointing.
   */
  snapshot(): GraphStateSnapshot;
}

// ============================================================================
// Execution Types
// ============================================================================

/**
 * Status of a graph execution.
 */
export enum ExecutionStatus {
  /** Execution is queued and waiting to start */
  PENDING = 'PENDING',
  /** Execution is actively running */
  RUNNING = 'RUNNING',
  /** Execution completed successfully */
  COMPLETED = 'COMPLETED',
  /** Execution failed (one or more nodes failed) */
  FAILED = 'FAILED',
  /** Execution timed out */
  TIMED_OUT = 'TIMED_OUT',
  /** Execution was cancelled */
  CANCELLED = 'CANCELLED',
}

/**
 * A layer in the execution plan — nodes at the same layer can run in parallel.
 * Layers are topologically sorted; layer N+1 depends on layer N.
 */
export interface ExecutionLayer {
  /** Layer index (0-based) */
  readonly index: number;
  /** Node definitions that can execute in parallel at this layer */
  readonly nodes: ReadonlyArray<AgentNodeDefinition>;
}

/**
 * The execution plan for a graph — layers topologically sorted.
 */
export interface ExecutionPlan {
  /** The graph this plan is for */
  readonly graphName: GraphName;
  /** Execution ID for this run */
  readonly executionId: ExecutionId;
  /** Ordered layers of nodes to execute */
  readonly layers: ReadonlyArray<ExecutionLayer>;
  /** Total number of nodes in the plan */
  readonly totalNodes: number;
  /** Nodes that were filtered out by conditions (pre-computed where possible) */
  readonly excludedNodes: ReadonlyArray<string>;
  /** Timestamp when the plan was created (ISO 8601) */
  readonly createdAt: string;
}

/**
 * A trace entry for a single node execution within a graph run.
 */
export interface NodeTrace {
  /** Unique ID for this trace entry */
  readonly traceId: NodeId;
  /** The node this trace is for */
  readonly nodeName: string;
  /** The agent that was executed */
  readonly agentName: AgentName;
  /** Execution status of this node */
  readonly status: ExecutionStatus;
  /** When the node started execution (ISO 8601) */
  readonly startedAt: string;
  /** When the node completed execution (ISO 8601) */
  readonly completedAt?: string;
  /** Duration in milliseconds (if completed) */
  readonly durationMs?: number;
  /** Number of retry attempts made */
  readonly retryCount: number;
  /** Error message if the node failed */
  readonly errorMessage?: string;
  /** The result produced (if successful) */
  readonly result?: AgentResult;
}

// ============================================================================
// Execution Request / Result
// ============================================================================

/**
 * Request to execute a named graph with an input payload.
 * This is what AIP Logic sends to the orchestrator.
 */
export interface ExecutionRequest {
  /** The graph to execute */
  readonly graphName: GraphName;
  /** The input payload for the graph */
  readonly input: AgentInput;
  /** Optional idempotency key to prevent duplicate execution */
  readonly idempotencyKey?: IdempotencyKey;
  /** Optional execution timeout override (ms) */
  readonly timeoutMs?: number;
  /** Optional metadata to attach to the execution */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of executing a graph.
 */
export interface ExecutionResult {
  /** The execution ID */
  readonly executionId: ExecutionId;
  /** The graph that was executed */
  readonly graphName: GraphName;
  /** Final execution status */
  readonly status: ExecutionStatus;
  /** The final graph state */
  readonly finalState: GraphStateSnapshot;
  /** Traces for all node executions */
  readonly traces: ReadonlyArray<NodeTrace>;
  /** Total execution duration in milliseconds */
  readonly durationMs: number;
  /** When execution started (ISO 8601) */
  readonly startedAt: string;
  /** When execution completed (ISO 8601) */
  readonly completedAt: string;
  /** The input that was provided */
  readonly input: AgentInput;
  /** Error message if execution failed */
  readonly errorMessage?: string;
}

// ============================================================================
// AgentGraph Interface
// ============================================================================

/**
 * Core interface for an AgentGraph.
 * Represents a directed acyclic graph (DAG) of agent nodes.
 */
export interface AgentGraph {
  /** Logical name of this graph */
  readonly name: GraphName;
  /** Metadata about this graph */
  readonly metadata: GraphMetadata;
  /** All node definitions in the graph */
  readonly nodes: ReadonlyMap<string, AgentNodeDefinition>;
  /** Topologically sorted node names (entry points first) */
  readonly topologicalOrder: ReadonlyArray<string>;
  /** Nodes with no dependencies (entry points) */
  readonly entryNodes: ReadonlyArray<string>;
  /** Nodes that nothing depends on (exit points) */
  readonly exitNodes: ReadonlyArray<string>;
  /** Validate the graph is a valid DAG */
  validate(): boolean;
  /** Get the execution plan for this graph */
  plan(executionId: ExecutionId): ExecutionPlan;
}

// ============================================================================
// Events
// ============================================================================

/**
 * Types of events emitted during graph execution.
 */
export enum ExecutionEventType {
  /** A graph execution has started */
  GRAPH_STARTED = 'graph.started',
  /** A node execution has started */
  NODE_STARTED = 'node.started',
  /** A node execution has completed successfully */
  NODE_COMPLETED = 'node.completed',
  /** A node execution has failed */
  NODE_FAILED = 'node.failed',
  /** A node was skipped because its condition returned false */
  NODE_SKIPPED = 'node.skipped',
  /** A node is being retried */
  NODE_RETRYING = 'node.retrying',
  /** A graph execution has completed */
  GRAPH_COMPLETED = 'graph.completed',
  /** A graph execution has failed */
  GRAPH_FAILED = 'graph.failed',
  /** A graph execution timed out */
  GRAPH_TIMED_OUT = 'graph.timed_out',
  /** Circuit breaker state changed */
  CIRCUIT_BREAKER_CHANGED = 'circuit_breaker.changed',
  /** A checkpoint was saved */
  CHECKPOINT_SAVED = 'checkpoint.saved',
}

/**
 * An event emitted during graph execution.
 */
export interface ExecutionEvent {
  /** The type of event */
  readonly type: ExecutionEventType;
  /** The execution ID this event belongs to */
  readonly executionId: ExecutionId;
  /** The graph name */
  readonly graphName: GraphName;
  /** Timestamp of the event (ISO 8601) */
  readonly timestamp: string;
  /** Event-specific payload */
  readonly payload: Record<string, unknown>;
}

/**
 * Listener function for execution events.
 */
export type ExecutionEventListener = (event: ExecutionEvent) => void;

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for the Apollo bridge.
 */
export interface ApolloConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly auth: {
    readonly type: 'bearer_token';
    readonly tokenEnvVar: string;
  };
}

/**
 * Configuration for Foundry integration.
 */
export interface FoundryConfig {
  readonly baseUrl: string;
  readonly tokenEnvVar: string;
  readonly ontology: {
    readonly rid: string;
    readonly actionTypeRid: string;
  };
  readonly dataset: {
    readonly rid: string;
    readonly branch: string;
  };
  readonly streams: {
    readonly eventStreamRid: string;
  };
}

/**
 * Complete orchestrator configuration.
 */
export interface OrchestratorConfig {
  readonly environment: 'dev' | 'staging' | 'prod';
  readonly apollo: ApolloConfig;
  readonly foundry: FoundryConfig;
  readonly agents: Readonly<Record<string, AgentNodeConfig>>;
  readonly graphs: {
    readonly maxParallelism: number;
    readonly executionTimeoutMs: number;
    readonly statePersist: boolean;
    readonly idempotency: {
      readonly enabled: boolean;
      readonly keyTtlSeconds: number;
    };
  };
  readonly retry: RetryPolicy;
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly logging: {
    readonly structuredLogging: boolean;
    readonly logLevel: LogLevel;
  };
}

// ============================================================================
// Graph Runner Events
// ============================================================================

/**
 * Interface for a node executor — the component that actually calls an agent.
 */
export interface AgentExecutor {
  /**
   * Execute a single agent with the given input.
   * @param config - The agent node configuration
   * @param input - The input to pass to the agent
   * @param executionId - The current execution ID for tracing
   * @returns A Result containing the agent output or an error
   */
  execute(
    config: AgentNodeConfig,
    input: AgentInput,
    executionId: ExecutionId,
  ): Promise<AgentResult>;
}

/**
 * Interface for a graph runner event emitter.
 */
export interface GraphEventEmitter {
  /** Register a listener for execution events */
  on(type: ExecutionEventType, listener: ExecutionEventListener): void;
  /** Remove a listener */
  off(type: ExecutionEventType, listener: ExecutionEventListener): void;
  /** Emit an event to all registered listeners */
  emit(event: ExecutionEvent): void;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a value is a valid AgentName.
 */
export function isAgentName(value: unknown): value is AgentName {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard to check if a value is a valid GraphName.
 */
export function isGraphName(value: unknown): value is GraphName {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard to check if a value is a valid ExecutionId.
 */
export function isExecutionId(value: unknown): value is ExecutionId {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard to check if a value is a valid NodeId.
 */
export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && value.length > 0;
}
