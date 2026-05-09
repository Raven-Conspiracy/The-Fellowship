/**
 * =============================================================================
 * AgentNode — Runtime Node Wrapper
 * =============================================================================
 *
 * Wraps an AgentNodeDefinition and provides runtime behavior:
 *   - Validates `dependsOn` references against the graph's nodes
 *   - Evaluates conditions against the current GraphState
 *   - Transforms input using the optional inputTransform
 *   - Provides timeout and retry policy resolution (node vs agent vs global)
 */

import type {
  AgentInput,
  AgentNodeConfig,
  AgentNodeDefinition,
  NodeCondition,
  InputTransform,
  ReadonlyGraphState,
  RetryPolicy,
} from '../core/types.js';
import { DEFAULT_RETRY_POLICY } from '../core/types.js';
import { InvalidGraphError } from '../core/errors.js';

// ============================================================================
// AgentNode Class
// ============================================================================

/**
 * Runtime representation of a node in an AgentGraph.
 * Wraps the static definition with runtime evaluation logic.
 */
export class AgentNode {
  private readonly _definition: AgentNodeDefinition;

  /**
   * @param definition - The node definition
   */
  constructor(definition: AgentNodeDefinition) {
    this._definition = definition;
  }

  // ==========================================================================
  // Basic Accessors
  // ==========================================================================

  /**
   * The unique name of this node within the graph.
   */
  get name(): string {
    return this._definition.name;
  }

  /**
   * The agent configuration for this node.
   */
  get config(): AgentNodeConfig {
    return this._definition.config;
  }

  /**
   * The names of nodes this node depends on.
   */
  get dependsOn(): ReadonlyArray<string> {
    return this._definition.dependsOn;
  }

  /**
   * Whether this is an entry node (no dependencies).
   */
  get isEntryNode(): boolean {
    return this._definition.dependsOn.length === 0;
  }

  /**
   * The node definition this wraps.
   */
  get definition(): AgentNodeDefinition {
    return this._definition;
  }

  // ==========================================================================
  // Condition Evaluation
  // ==========================================================================

  /**
   * Check if this node has a condition guard.
   */
  get hasCondition(): boolean {
    return this._definition.condition !== undefined;
  }

  /**
   * Evaluate the node's condition against the current state.
   * If no condition is defined, the node always runs.
   *
   * @param state - The current graph state
   * @returns true if the node should execute
   */
  evaluateCondition(state: ReadonlyGraphState): boolean {
    if (!this._definition.condition) {
      return true;
    }

    try {
      return this._definition.condition(state);
    } catch (error) {
      // If a condition throws, log and default to false (safe)
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Condition evaluation failed for node "${this.name}": ${message}`,
      );
    }
  }

  // ==========================================================================
  // Input Resolution
  // ==========================================================================

  /**
   * Determine the input for this node based on the current state.
   * If an inputTransform is defined, uses it. Otherwise, defaults to
   * merging the outputs of all dependency nodes.
   *
   * @param state - The current graph state
   * @returns The input to pass to the agent
   */
  resolveInput(state: ReadonlyGraphState): AgentInput {
    if (this._definition.inputTransform) {
      try {
        return this._definition.inputTransform(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Input transform failed for node "${this.name}": ${message}`,
        );
      }
    }

    // Default: merge all dependency outputs into a single input
    return this._mergeDependencyOutputs(state);
  }

  /**
   * Merge the outputs of all dependency nodes into a single input object.
   * Each dependency's output is stored under its node name as a key.
   *
   * @param state - The current graph state
   * @returns The merged input
   */
  private _mergeDependencyOutputs(state: ReadonlyGraphState): AgentInput {
    const input: AgentInput = {};

    if (this.isEntryNode) {
      // Entry nodes get the original graph input
      return { ...state.input };
    }

    for (const dep of this._definition.dependsOn) {
      const result = state.get(dep);
      if (result && result.success) {
        input[dep] = result.output;
      }
    }

    return input;
  }

  // ==========================================================================
  // Timeout Resolution
  // ==========================================================================

  /**
   * Get the effective timeout for this node.
   * Resolution order: node override → agent config → default.
   *
   * @param defaultTimeoutMs - The global default timeout
   * @returns The effective timeout in milliseconds
   */
  getEffectiveTimeout(defaultTimeoutMs: number = 30_000): number {
    if (this._definition.timeoutMs !== undefined) {
      return this._definition.timeoutMs;
    }
    return this._definition.config.timeoutMs || defaultTimeoutMs;
  }

  // ==========================================================================
  // Retry Policy Resolution
  // ==========================================================================

  /**
   * Get the effective retry policy for this node.
   * Resolution order: node override → agent config → default.
   *
   * @param defaultRetryPolicy - The global default retry policy
   * @returns The effective retry policy
   */
  getEffectiveRetryPolicy(
    defaultRetryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): RetryPolicy {
    if (this._definition.retryPolicy) {
      return this._definition.retryPolicy;
    }
    if (this._definition.config.retryPolicy) {
      return this._definition.config.retryPolicy;
    }
    return defaultRetryPolicy;
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate that all `dependsOn` references point to existing nodes in the graph.
   *
   * @param allNodeNames - Set of all node names in the graph
   * @throws InvalidGraphError if any dependency references a non-existent node
   */
  validateReferences(allNodeNames: ReadonlySet<string>): void {
    const missing = this._definition.dependsOn.filter(
      (dep) => !allNodeNames.has(dep),
    );

    if (missing.length > 0) {
      throw new InvalidGraphError(
        this.name,
        missing.map(
          (dep) =>
            `Node "${this.name}" depends on "${dep}" which does not exist in the graph`,
        ),
      );
    }
  }

  // ==========================================================================
  // All Dependencies Satisfied Check
  // ==========================================================================

  /**
   * Check if all dependencies of this node have completed successfully.
   *
   * @param state - The current graph state
   * @returns true if all dependencies have completed
   */
  allDependenciesSatisfied(state: ReadonlyGraphState): boolean {
    if (this.isEntryNode) {
      return true;
    }

    return this._definition.dependsOn.every((dep) => state.has(dep));
  }

  // ==========================================================================
  // Serialization
  // ==========================================================================

  /**
   * Convert to a plain object for logging/serialization.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      agentName: this.config.agentName,
      dependsOn: [...this.dependsOn],
      isEntryNode: this.isEntryNode,
      hasCondition: this.hasCondition,
      hasInputTransform: this._definition.inputTransform !== undefined,
      timeoutMs: this.getEffectiveTimeout(),
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an AgentNode from a definition.
 *
 * @param definition - The node definition
 * @returns An AgentNode instance
 */
export function createAgentNode(definition: AgentNodeDefinition): AgentNode {
  return new AgentNode(definition);
}
