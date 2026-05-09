/**
 * =============================================================================
 * GraphBuilder — Fluent Builder API for AgentGraph Definitions
 * =============================================================================
 *
 * Provides a fluent builder API for constructing AgentGraph instances:
 *
 * ```typescript
 * const triage = new GraphBuilder("incident-triage")
 *   .node("classify",  agents.CLASSIFIER)
 *   .node("analyze",   agents.ANALYZER,  { dependsOn: ["classify"] })
 *   .node("summarize", agents.SUMMARIZER, { dependsOn: ["analyze"] })
 *   .node("escalate",  agents.ESCALATOR, {
 *     dependsOn: ["analyze"],
 *     condition: (state) => state.get("analyze").confidence < 0.7,
 *   })
 *   .build();
 * ```
 */

import type {
  AgentNodeConfig,
  AgentNodeDefinition,
  AgentGraph,
  GraphMetadata,
  GraphName,
  NodeCondition,
  InputTransform,
  RetryPolicy,
} from '../core/types.js';
import { GraphName as CreateGraphName } from '../core/types.js';
import { AgentGraphImpl } from './agent-graph.js';

// ============================================================================
// Node Builder Options
// ============================================================================

/**
 * Options for adding a node to the graph via the builder.
 */
export interface NodeOptions {
  /** Names of nodes this node depends on */
  dependsOn?: ReadonlyArray<string>;
  /** Optional condition — if false, this node is skipped */
  condition?: NodeCondition;
  /** Optional input transform — overrides default input mapping */
  inputTransform?: InputTransform;
  /** Optional timeout override for this specific node */
  timeoutMs?: number;
  /** Optional retry policy override for this specific node */
  retryPolicy?: RetryPolicy;
}

// ============================================================================
// Graph Builder Options
// ============================================================================

/**
 * Options for the GraphBuilder itself.
 */
export interface GraphBuilderOptions {
  /** Human-readable description of the graph */
  description?: string;
  /** Version string */
  version?: string;
  /** Tags for categorization */
  tags?: ReadonlyArray<string>;
  /** Owner team or individual */
  owner?: string;
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
}

// ============================================================================
// GraphBuilder
// ============================================================================

/**
 * Fluent builder for constructing AgentGraph instances.
 *
 * Collects node definitions and validates the resulting graph on build().
 *
 * @example
 * ```typescript
 * const graph = new GraphBuilder("incident-triage", { owner: "platform-team" })
 *   .node("classify", classifierConfig)
 *   .node("analyze", analyzerConfig, { dependsOn: ["classify"] })
 *   .build();
 * ```
 */
export class GraphBuilder {
  private readonly _graphName: GraphName;
  private readonly _options: GraphBuilderOptions;
  private readonly _nodes: Map<string, AgentNodeDefinition> = new Map();
  private readonly _nodeNames: Set<string> = new Set();

  /**
   * @param graphName - The logical name for this graph
   * @param options - Optional graph-level options
   */
  constructor(graphName: string, options: GraphBuilderOptions = {}) {
    this._graphName = CreateGraphName(graphName);
    this._options = options;
  }

  /**
   * Add a node to the graph.
   *
   * @param name - Unique logical name for this node within the graph
   * @param config - The agent configuration for this node
   * @param options - Optional node options (dependsOn, condition, etc.)
   * @returns This builder (for chaining)
   * @throws Error if a node with this name already exists
   */
  node(
    name: string,
    config: AgentNodeConfig,
    options: NodeOptions = {},
  ): GraphBuilder {
    if (this._nodeNames.has(name)) {
      throw new Error(
        `Duplicate node name "${name}" in graph "${this._graphName}". Each node must have a unique name.`,
      );
    }

    this._nodeNames.add(name);

    const definition: AgentNodeDefinition = {
      name,
      config,
      dependsOn: options.dependsOn ?? [],
      condition: options.condition,
      inputTransform: options.inputTransform,
      timeoutMs: options.timeoutMs,
      retryPolicy: options.retryPolicy,
    };

    this._nodes.set(name, definition);

    return this;
  }

  /**
   * Build and validate the AgentGraph.
   *
   * @returns A validated AgentGraph
   * @throws CyclicGraphError if the graph contains a cycle
   * @throws InvalidGraphError if the graph is structurally invalid
   */
  build(): AgentGraph {
    const now = new Date().toISOString();

    const metadata: GraphMetadata = {
      name: this._graphName,
      description: this._options.description ?? `Graph: ${this._graphName}`,
      version: this._options.version ?? '1.0.0',
      createdAt: now,
      updatedAt: now,
      tags: this._options.tags ?? [],
      owner: this._options.owner ?? 'unknown',
      inputSchema: this._options.inputSchema,
    };

    const nodeDefinitions = [...this._nodes.values()];

    // The AgentGraphImpl constructor validates the graph
    return new AgentGraphImpl(this._graphName, metadata, nodeDefinitions);
  }

  /**
   * Get the number of nodes added so far.
   */
  get nodeCount(): number {
    return this._nodes.size;
  }

  /**
   * Get the names of all nodes added so far.
   */
  get nodeNames(): ReadonlyArray<string> {
    return [...this._nodeNames];
  }

  /**
   * Check if a node with the given name has been added.
   */
  hasNode(name: string): boolean {
    return this._nodeNames.has(name);
  }

  /**
   * Remove a node from the builder (if it hasn't been built yet).
   * Also removes this node from any other node's dependsOn list.
   *
   * @param name - The node to remove
   * @returns This builder (for chaining)
   */
  removeNode(name: string): GraphBuilder {
    if (!this._nodeNames.has(name)) {
      return this;
    }

    this._nodes.delete(name);
    this._nodeNames.delete(name);

    // Remove references to this node from other nodes' dependsOn
    for (const [nodeName, nodeDef] of this._nodes) {
      if (nodeDef.dependsOn.includes(name)) {
        const newDependsOn = nodeDef.dependsOn.filter((d) => d !== name);
        this._nodes.set(nodeName, {
          ...nodeDef,
          dependsOn: newDependsOn,
        });
      }
    }

    return this;
  }

  /**
   * Set graph-level metadata options.
   *
   * @param options - Options to set/override
   * @returns This builder (for chaining)
   */
  withOptions(options: Partial<GraphBuilderOptions>): GraphBuilder {
    Object.assign(this._options, options);
    return this;
  }

  /**
   * Clone the current builder state into a new GraphBuilder.
   * Useful for creating variations of a graph.
   *
   * @param newName - Optional new graph name
   * @returns A new GraphBuilder with the same nodes
   */
  clone(newName?: string): GraphBuilder {
    const builder = new GraphBuilder(
      newName ?? (this._graphName as unknown as string),
      { ...this._options },
    );

    for (const [name, def] of this._nodes) {
      builder._nodes.set(name, { ...def, dependsOn: [...def.dependsOn] });
      builder._nodeNames.add(name);
    }

    return builder;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new GraphBuilder for building an AgentGraph.
 *
 * @param name - The graph name
 * @param options - Optional graph-level options
 * @returns A new GraphBuilder
 *
 * @example
 * ```typescript
 * const graph = createGraphBuilder("my-graph", { owner: "team-x" })
 *   .node("step1", configA)
 *   .node("step2", configB, { dependsOn: ["step1"] })
 *   .build();
 * ```
 */
export function createGraphBuilder(
  name: string,
  options?: GraphBuilderOptions,
): GraphBuilder {
  return new GraphBuilder(name, options);
}
