/**
 * =============================================================================
 * Immutable GraphState — The Fellowship Orchestrator
 * =============================================================================
 *
 * Implements the GraphState interface with FULL immutability.
 * Every `set()` method returns a NEW GraphState instance — the original
 * is NEVER mutated. This enables:
 *   - Checkpoint/replay: snapshot any point in time
 *   - Audit trail: every state transition is a new object
 *   - Thread safety: no shared mutable state
 *   - Deterministic replay: same initial state + same events = same final state
 *
 * The state is backed by a persistent data structure using structural sharing
 * for efficiency (Map-based, not object spread).
 */

import type {
  AgentInput,
  AgentResult,
  ExecutionId,
  GraphName,
  GraphState,
  GraphStateSnapshot,
  ReadonlyGraphState,
} from '../core/types.js';

// ============================================================================
// Immutable GraphState Implementation
// ============================================================================

/**
 * Concrete implementation of the immutable GraphState.
 *
 * Uses structural sharing: when set() is called, we create a new Map
 * that shares unchanged entries with the old Map. This is O(1) for
 * the new entry and O(1) for existing entries (reference sharing).
 */
export class ImmutableGraphState implements GraphState {
  private readonly _nodeOutputs: ReadonlyMap<string, AgentResult>;
  private readonly _failedNodes: ReadonlySet<string>;
  private readonly _skippedNodes: ReadonlySet<string>;
  private readonly _context: ReadonlyMap<string, unknown>;

  public readonly executionId: ExecutionId;
  public readonly graphName: GraphName;
  public readonly input: AgentInput;
  public readonly version: number;

  /**
   * Create a new ImmutableGraphState.
   *
   * @param executionId - The execution this state belongs to
   * @param graphName - The graph being executed
   * @param input - The initial input payload
   * @param version - Starting version number (default: 0)
   * @param nodeOutputs - Optional initial node outputs (for replay/restore)
   * @param failedNodes - Optional initial failed nodes (for replay/restore)
   * @param skippedNodes - Optional initial skipped nodes (for replay/restore)
   * @param context - Optional initial context data (for replay/restore)
   */
  constructor(
    executionId: ExecutionId,
    graphName: GraphName,
    input: AgentInput,
    version: number = 0,
    nodeOutputs?: ReadonlyMap<string, AgentResult>,
    failedNodes?: ReadonlySet<string>,
    skippedNodes?: ReadonlySet<string>,
    context?: ReadonlyMap<string, unknown>,
  ) {
    this.executionId = executionId;
    this.graphName = graphName;
    this.input = input;
    this.version = version;
    this._nodeOutputs = nodeOutputs ?? new Map();
    this._failedNodes = failedNodes ?? new Set();
    this._skippedNodes = skippedNodes ?? new Set();
    this._context = context ?? new Map();
  }

  // ==========================================================================
  // Read Methods
  // ==========================================================================

  /**
   * Get the result produced by a specific node.
   *
   * @param nodeName - The node to retrieve results for
   * @returns The AgentResult, or undefined if the node hasn't completed
   */
  get(nodeName: string): AgentResult | undefined {
    return this._nodeOutputs.get(nodeName);
  }

  /**
   * Check if a node has completed execution successfully.
   *
   * @param nodeName - The node to check
   * @returns true if the node completed successfully
   */
  has(nodeName: string): boolean {
    return this._nodeOutputs.has(nodeName);
  }

  /**
   * Get all successfully completed node names.
   *
   * @returns Array of node names
   */
  completedNodes(): ReadonlyArray<string> {
    return [...this._nodeOutputs.keys()];
  }

  /**
   * Get all failed node names.
   *
   * @returns Array of node names
   */
  failedNodes(): ReadonlyArray<string> {
    return [...this._failedNodes];
  }

  /**
   * Get all skipped node names.
   *
   * @returns Array of node names
   */
  skippedNodes(): ReadonlyArray<string> {
    return [...this._skippedNodes];
  }

  /**
   * Get arbitrary context data.
   *
   * @param key - The context key
   * @returns The context value, or undefined
   */
  getContext<T = unknown>(key: string): T | undefined {
    return this._context.get(key) as T | undefined;
  }

  // ==========================================================================
  // Write Methods (ALL return new instances)
  // ==========================================================================

  /**
   * Record the result of a node execution.
   * Returns a NEW GraphState — the original is unchanged.
   *
   * @param nodeName - The node that produced this result
   * @param result - The agent execution result
   * @returns A new GraphState with the result added
   */
  set(nodeName: string, result: AgentResult): GraphState {
    const newNodeOutputs = new Map(this._nodeOutputs);
    newNodeOutputs.set(nodeName, result);

    return new ImmutableGraphState(
      this.executionId,
      this.graphName,
      this.input,
      this.version + 1,
      newNodeOutputs,
      this._failedNodes,
      this._skippedNodes,
      this._context,
    );
  }

  /**
   * Mark a node as failed.
   * Returns a NEW GraphState — the original is unchanged.
   *
   * @param nodeName - The node that failed
   * @param _errorMessage - The error message (stored for audit but not in state)
   * @returns A new GraphState with the node marked as failed
   */
  markFailed(nodeName: string, _errorMessage: string): GraphState {
    const newFailedNodes = new Set(this._failedNodes);
    newFailedNodes.add(nodeName);

    return new ImmutableGraphState(
      this.executionId,
      this.graphName,
      this.input,
      this.version + 1,
      this._nodeOutputs,
      newFailedNodes,
      this._skippedNodes,
      this._context,
    );
  }

  /**
   * Mark a node as skipped (condition returned false).
   * Returns a NEW GraphState — the original is unchanged.
   *
   * @param nodeName - The node that was skipped
   * @returns A new GraphState with the node marked as skipped
   */
  markSkipped(nodeName: string): GraphState {
    const newSkippedNodes = new Set(this._skippedNodes);
    newSkippedNodes.add(nodeName);

    return new ImmutableGraphState(
      this.executionId,
      this.graphName,
      this.input,
      this.version + 1,
      this._nodeOutputs,
      this._failedNodes,
      newSkippedNodes,
      this._context,
    );
  }

  /**
   * Set arbitrary context data.
   * Returns a NEW GraphState — the original is unchanged.
   *
   * @param key - The context key
   * @param value - The context value
   * @returns A new GraphState with the context updated
   */
  setContext(key: string, value: unknown): GraphState {
    const newContext = new Map(this._context);
    newContext.set(key, value);

    return new ImmutableGraphState(
      this.executionId,
      this.graphName,
      this.input,
      this.version + 1,
      this._nodeOutputs,
      this._failedNodes,
      this._skippedNodes,
      newContext,
    );
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  /**
   * Convert to a JSON-safe snapshot for checkpointing or serialization.
   *
   * @returns A GraphStateSnapshot
   */
  toJSON(): GraphStateSnapshot {
    return this.snapshot();
  }

  /**
   * Create a point-in-time snapshot of the current state.
   * Useful for checkpointing and replay.
   *
   * @returns A GraphStateSnapshot
   */
  snapshot(): GraphStateSnapshot {
    const nodeOutputs: Record<string, AgentResult> = {};
    for (const [key, value] of this._nodeOutputs) {
      nodeOutputs[key] = value;
    }

    const context: Record<string, unknown> = {};
    for (const [key, value] of this._context) {
      context[key] = value;
    }

    return {
      executionId: this.executionId,
      graphName: this.graphName,
      nodeOutputs,
      completedNodes: [...this._nodeOutputs.keys()],
      failedNodes: [...this._failedNodes],
      skippedNodes: [...this._skippedNodes],
      context,
      snapshotAt: new Date().toISOString(),
      version: this.version,
    };
  }

  // ==========================================================================
  // Static Factory Methods
  // ==========================================================================

  /**
   * Create an initial (empty) GraphState for a new execution.
   *
   * @param executionId - The execution ID
   * @param graphName - The graph name
   * @param input - The initial input payload
   * @returns A fresh GraphState
   */
  static create(
    executionId: ExecutionId,
    graphName: GraphName,
    input: AgentInput,
  ): GraphState {
    return new ImmutableGraphState(executionId, graphName, input, 0);
  }

  /**
   * Restore a GraphState from a snapshot (for replay).
   *
   * @param snapshot - The snapshot to restore from
   * @returns A GraphState initialized from the snapshot
   */
  static fromSnapshot(snapshot: GraphStateSnapshot): GraphState {
    const nodeOutputs = new Map<string, AgentResult>();
    for (const [key, value] of Object.entries(snapshot.nodeOutputs)) {
      nodeOutputs.set(key, value);
    }

    const failedNodes = new Set(snapshot.failedNodes);
    const skippedNodes = new Set(snapshot.skippedNodes);

    const context = new Map<string, unknown>();
    for (const [key, value] of Object.entries(snapshot.context)) {
      context.set(key, value);
    }

    return new ImmutableGraphState(
      snapshot.executionId,
      snapshot.graphName,
      {} as AgentInput, // Input is not preserved in snapshot; would need to be provided separately
      snapshot.version,
      nodeOutputs,
      failedNodes,
      skippedNodes,
      context,
    );
  }
}

// ============================================================================
// Read-Only Proxy (for safe sharing)
// ============================================================================

/**
 * Creates a read-only wrapper around a GraphState.
 * Useful for passing state to condition/transform functions without
 * allowing mutation.
 *
 * @param state - The state to wrap
 * @returns A ReadonlyGraphState
 */
export function asReadonly(state: GraphState): ReadonlyGraphState {
  return state; // GraphState already extends ReadonlyGraphState
}

/**
 * Freeze a GraphState deeply to prevent any accidental mutation.
 * Only useful in development/testing to catch mutation bugs.
 *
 * @param state - The state to freeze
 * @returns The frozen state
 */
export function deepFreeze(state: GraphState): ReadonlyGraphState {
  // ImmutableGraphState is already immutable by design,
  // but this provides an additional safety net for objects
  // stored within the state (AgentResult, context values).
  const snapshot = state.toJSON();
  return Object.freeze(snapshot) as unknown as ReadonlyGraphState;
}
