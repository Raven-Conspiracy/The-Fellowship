/**
 * =============================================================================
 * GraphRunner — The Heart of the Orchestrator
 * =============================================================================
 *
 * Walks the DAG, executes nodes in topological order, manages state,
 * handles retries, circuit breaker, conditional nodes, parallel execution,
 * and emits events.
 *
 * The execution model:
 *   1. Load the AgentGraph and generate an ExecutionPlan
 *   2. Process layers sequentially (layer 0 → layer 1 → ... → layer N)
 *   3. Within each layer, execute nodes in parallel
 *   4. After each node execution, update the immutable GraphState
 *   5. Evaluate conditions before executing dependent nodes
 *   6. Apply retry logic and circuit breaker to each node call
 *   7. Emit events at each lifecycle step
 */

import type {
  AgentExecutor,
  AgentGraph,
  AgentNodeConfig,
  AgentNodeDefinition,
  AgentResult,
  ExecutionEvent,
  ExecutionId,
  ExecutionPlan,
  ExecutionResult,
  ExecutionStatus,
  GraphEventEmitter,
  GraphState,
  Logger,
  NodeTrace,
  ReadonlyGraphState,
} from '../core/types.js';
import {
  ExecutionEventType,
  LogLevel,
} from '../core/types.js';
import { ImmutableGraphState } from './graph-state.js';
import { AgentNode } from './agent-node.js';
import { withRetry } from '../utils/retry.js';
import type { RetryOptions } from '../utils/retry.js';
import {
  NodeExecutionError,
  ExecutionTimeoutError,
  CircuitBreakerOpenError,
  isRetryableError,
} from '../core/errors.js';
import type { OrchestrationError } from '../core/errors.js';
import { CircuitBreaker } from '../utils/circuit-breaker.js';
import { generateNodeId } from '../utils/id-generator.js';

// ============================================================================
// GraphRunner Options
// ============================================================================

/**
 * Configuration for a GraphRunner execution.
 */
export interface GraphRunnerOptions {
  /** The graph to execute */
  graph: AgentGraph;
  /** The executor that calls agents */
  agentExecutor: AgentExecutor;
  /** Optional event emitter for lifecycle hooks */
  eventEmitter?: GraphEventEmitter;
  /** Logger instance */
  logger?: Logger;
  /** Maximum parallel node executions within a layer */
  maxParallelism?: number;
  /** Global execution timeout in milliseconds */
  executionTimeoutMs?: number;
  /** Circuit breakers keyed by agent name */
  circuitBreakers?: Map<string, CircuitBreaker>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// GraphRunner
// ============================================================================

/**
 * Executes an AgentGraph against real agents via the AgentExecutor.
 *
 * The runner is stateless — all execution state is managed through the
 * immutable GraphState that flows through the execution.
 */
export class GraphRunner {
  private readonly options: Required<GraphRunnerOptions>;

  constructor(options: GraphRunnerOptions) {
    this.options = {
      graph: options.graph,
      agentExecutor: options.agentExecutor,
      eventEmitter: options.eventEmitter ?? createNoopEventEmitter(),
      logger: options.logger,
      maxParallelism: options.maxParallelism ?? 5,
      executionTimeoutMs: options.executionTimeoutMs ?? 300_000,
      circuitBreakers: options.circuitBreakers ?? new Map(),
      signal: options.signal ?? new AbortController().signal,
    };
  }

  // ==========================================================================
  // Main Execution Entry Point
  // ==========================================================================

  /**
   * Execute the graph with the given input and execution ID.
   *
   * @param executionId - Unique ID for this execution run
   * @param initialInput - The initial input payload
   * @returns An ExecutionResult with the final state and traces
   */
  async execute(
    executionId: ExecutionId,
    initialInput: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const traces: NodeTrace[] = [];

    // Create initial state
    let state: GraphState = ImmutableGraphState.create(
      executionId,
      this.options.graph.name,
      initialInput,
    );

    // Emit graph.started
    this._emit(ExecutionEventType.GRAPH_STARTED, executionId, {
      graphName: this.options.graph.name,
      input: initialInput,
    });

    try {
      // Generate execution plan
      const plan = this.options.graph.plan(executionId);

      this.options.logger?.info('Execution plan generated', {
        executionId,
        graphName: this.options.graph.name,
        layers: plan.layers.length,
        totalNodes: plan.totalNodes,
      });

      // Set up execution timeout
      const timeoutPromise = this._createTimeoutPromise(
        executionId,
        this.options.graph.name as unknown as string,
      );

      // Process each layer sequentially
      for (const layer of plan.layers) {
        // Check for abort signal
        if (this.options.signal.aborted) {
          return this._buildResult(
            executionId,
            startedAt,
            state,
            traces,
            ExecutionStatus.CANCELLED,
            'Execution was cancelled',
          );
        }

        this.options.logger?.debug(`Processing layer ${layer.index}`, {
          executionId,
          layer: layer.index,
          nodeCount: layer.nodes.length,
          nodes: layer.nodes.map((n) => n.name),
        });

        // Execute all nodes in this layer in parallel
        const layerResult = await this._executeLayer(
          layer.nodes,
          state,
          executionId,
          traces,
        );

        // Update state with layer results
        state = layerResult.state;
      }

      // Check if any nodes failed
      const failedNodes = state.failedNodes();
      const status =
        failedNodes.length > 0 ? ExecutionStatus.FAILED : ExecutionStatus.COMPLETED;

      this._emit(
        status === ExecutionStatus.COMPLETED
          ? ExecutionEventType.GRAPH_COMPLETED
          : ExecutionEventType.GRAPH_FAILED,
        executionId,
        {
          graphName: this.options.graph.name,
          failedNodes: [...failedNodes],
          completedNodes: [...state.completedNodes()],
        },
      );

      return this._buildResult(executionId, startedAt, state, traces, status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = error instanceof ExecutionTimeoutError;

      this._emit(
        isTimeout ? ExecutionEventType.GRAPH_TIMED_OUT : ExecutionEventType.GRAPH_FAILED,
        executionId,
        {
          error: message,
        },
      );

      return this._buildResult(
        executionId,
        startedAt,
        state,
        traces,
        isTimeout ? ExecutionStatus.TIMED_OUT : ExecutionStatus.FAILED,
        message,
      );
    }
  }

  // ==========================================================================
  // Layer Execution
  // ==========================================================================

  /**
   * Execute all nodes in a layer in parallel.
   */
  private async _executeLayer(
    nodes: ReadonlyArray<AgentNodeDefinition>,
    state: GraphState,
    executionId: ExecutionId,
    traces: NodeTrace[],
  ): Promise<{ state: GraphState }> {
    let currentState = state;

    // Filter out nodes that don't need to run (conditions already evaluated to false)
    const nodesToExecute: AgentNode[] = [];
    const nodesToSkip: string[] = [];

    for (const nodeDef of nodes) {
      const agentNode = new AgentNode(nodeDef);

      // Check if all dependencies are satisfied
      if (!agentNode.allDependenciesSatisfied(currentState)) {
        // This shouldn't happen with proper plan layering, but be defensive
        this.options.logger?.warn('Node has unsatisfied dependencies', {
          executionId,
          nodeName: agentNode.name,
          dependsOn: [...agentNode.dependsOn],
          completedNodes: [...currentState.completedNodes()],
        });
        continue;
      }

      // Evaluate condition
      try {
        const shouldRun = agentNode.evaluateCondition(currentState);
        if (!shouldRun) {
          nodesToSkip.push(agentNode.name);
          this._emit(ExecutionEventType.NODE_SKIPPED, executionId, {
            nodeName: agentNode.name,
          });
          currentState = currentState.markSkipped(agentNode.name);
          continue;
        }
      } catch (conditionError) {
        const message =
          conditionError instanceof Error ? conditionError.message : String(conditionError);
        this.options.logger?.error('Condition evaluation failed', {
          executionId,
          nodeName: agentNode.name,
          error: message,
        });
        nodesToSkip.push(agentNode.name);
        currentState = currentState.markSkipped(agentNode.name);
        continue;
      }

      nodesToExecute.push(agentNode);
    }

    // Execute nodes in parallel with concurrency limit
    if (nodesToExecute.length > 0) {
      const results = await this._executeWithConcurrencyLimit(
        nodesToExecute,
        currentState,
        executionId,
        traces,
      );

      // Merge all results into state
      for (const result of results) {
        if (result.success) {
          currentState = currentState.set(result.nodeName, result);
        } else {
          currentState = currentState.markFailed(
            result.nodeName,
            result.errorMessage ?? 'Unknown error',
          );
        }
      }
    }

    return { state: currentState };
  }

  // ==========================================================================
  // Concurrent Execution with Limit
  // ==========================================================================

  /**
   * Execute multiple nodes with a concurrency limit.
   */
  private async _executeWithConcurrencyLimit(
    nodes: AgentNode[],
    state: GraphState,
    executionId: ExecutionId,
    traces: NodeTrace[],
  ): Promise<AgentResult[]> {
    const limit = this.options.maxParallelism;
    const results: AgentResult[] = [];
    let index = 0;

    const executeNext = async (): Promise<void> => {
      while (index < nodes.length) {
        const currentIndex = index;
        index++;
        const node = nodes[currentIndex]!;

        const result = await this._executeNode(node, state, executionId, traces);
        results.push(result);
      }
    };

    // Start `limit` concurrent workers
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(limit, nodes.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(executeNext());
    }

    await Promise.all(workers);
    return results;
  }

  // ==========================================================================
  // Single Node Execution
  // ==========================================================================

  /**
   * Execute a single node with retry and circuit breaker.
   */
  private async _executeNode(
    node: AgentNode,
    state: GraphState,
    executionId: ExecutionId,
    traces: NodeTrace[],
  ): Promise<AgentResult> {
    const nodeId = generateNodeId();
    const startedAt = new Date().toISOString();
    let retryCount = 0;

    // Emit node.started
    this._emit(ExecutionEventType.NODE_STARTED, executionId, {
      nodeName: node.name,
      agentName: node.config.agentName,
      nodeId,
    });

    // Create trace entry
    const trace: NodeTrace = {
      traceId: nodeId,
      nodeName: node.name,
      agentName: node.config.agentName,
      status: ExecutionStatus.RUNNING,
      startedAt,
      retryCount: 0,
    };
    traces.push(trace);

    try {
      // Resolve input
      const input = node.resolveInput(state);

      // Get circuit breaker for this agent
      const circuitBreaker = this.options.circuitBreakers.get(
        node.config.agentName as unknown as string,
      );

      // Build retry options
      const retryPolicy = node.getEffectiveRetryPolicy();
      const retryOptions: RetryOptions = {
        ...retryPolicy,
        logger: this.options.logger,
        signal: this.options.signal,
        onRetry: (attempt: number, error: Error, delayMs: number) => {
          retryCount++;
          trace.retryCount = retryCount;
          this._emit(ExecutionEventType.NODE_RETRYING, executionId, {
            nodeName: node.name,
            attempt,
            delayMs,
            error: error.message,
          });
        },
      };

      // Execute with retry
      const result = await withRetry(
        async () => {
          // Check circuit breaker
          if (circuitBreaker && circuitBreaker.isOpen()) {
            const snapshot = circuitBreaker.snapshot();
            throw new CircuitBreakerOpenError(
              node.config.agentName as unknown as string,
              snapshot.openedAt ?? new Date().toISOString(),
            );
          }

          // Execute via the agent executor
          const agentResult = await this.options.agentExecutor.execute(
            node.config,
            input,
            executionId,
          );

          // Record success in circuit breaker
          if (circuitBreaker) {
            // Success is handled via the call method, but we're not using that here
            circuitBreaker['_onSuccess']?.();
          }

          return agentResult;
        },
        retryOptions,
      );

      // Update trace
      trace.status = ExecutionStatus.COMPLETED;
      trace.completedAt = result.completedAt;
      trace.durationMs = result.durationMs;
      trace.result = result;
      trace.retryCount = retryCount;

      // Emit node.completed
      this._emit(ExecutionEventType.NODE_COMPLETED, executionId, {
        nodeName: node.name,
        agentName: node.config.agentName,
        nodeId,
        durationMs: result.durationMs,
        retryCount,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

      // Record failure in circuit breaker
      const circuitBreaker = this.options.circuitBreakers.get(
        node.config.agentName as unknown as string,
      );
      if (circuitBreaker) {
        circuitBreaker['_onFailure']?.();
      }

      // Update trace
      trace.status = ExecutionStatus.FAILED;
      trace.completedAt = completedAt;
      trace.durationMs = durationMs;
      trace.errorMessage = message;
      trace.retryCount = retryCount;

      // Emit node.failed
      this._emit(ExecutionEventType.NODE_FAILED, executionId, {
        nodeName: node.name,
        agentName: node.config.agentName,
        nodeId,
        error: message,
        durationMs,
        retryCount,
      });

      // Return a failed AgentResult
      return {
        nodeId,
        agentName: node.config.agentName,
        output: {},
        durationMs,
        retryCount,
        startedAt,
        completedAt,
        success: false,
        errorMessage: message,
      };
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Build the final ExecutionResult.
   */
  private _buildResult(
    executionId: ExecutionId,
    startedAt: string,
    state: GraphState,
    traces: NodeTrace[],
    status: ExecutionStatus,
    errorMessage?: string,
  ): ExecutionResult {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      executionId,
      graphName: this.options.graph.name,
      status,
      finalState: state.toJSON(),
      traces,
      durationMs,
      startedAt,
      completedAt,
      input: state.input,
      errorMessage,
    };
  }

  /**
   * Create a timeout promise that rejects after the specified duration.
   */
  private _createTimeoutPromise(
    executionId: ExecutionId,
    graphName: string,
  ): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new ExecutionTimeoutError(
            executionId as unknown as string,
            graphName,
            this.options.executionTimeoutMs,
          ),
        );
      }, this.options.executionTimeoutMs);
    });
  }

  /**
   * Emit an event to the event emitter.
   */
  private _emit(
    type: ExecutionEventType,
    executionId: ExecutionId,
    payload: Record<string, unknown>,
  ): void {
    try {
      const event: ExecutionEvent = {
        type,
        executionId,
        graphName: this.options.graph.name,
        timestamp: new Date().toISOString(),
        payload,
      };
      this.options.eventEmitter.emit(event);
    } catch {
      // Event emission should never break execution
      this.options.logger?.warn('Failed to emit event', {
        executionId,
        eventType: type,
      });
    }
  }
}

// ============================================================================
// Noop Event Emitter
// ============================================================================

/**
 * Create a noop event emitter for when none is provided.
 */
function createNoopEventEmitter(): GraphEventEmitter {
  return {
    on(_type: ExecutionEventType, _listener: (event: ExecutionEvent) => void): void {
      // noop
    },
    off(_type: ExecutionEventType, _listener: (event: ExecutionEvent) => void): void {
      // noop
    },
    emit(_event: ExecutionEvent): void {
      // noop
    },
  };
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Execute a graph with the given input.
 * Convenience function that creates a GraphRunner and executes.
 *
 * @param options - Graph runner options
 * @param executionId - Unique execution ID
 * @param input - The input payload
 * @returns An ExecutionResult
 */
export async function runGraph(
  options: GraphRunnerOptions,
  executionId: ExecutionId,
  input: Record<string, unknown>,
): Promise<ExecutionResult> {
  const runner = new GraphRunner(options);
  return runner.execute(executionId, input);
}
