/**
 * =============================================================================
 * AgentGraph — DAG Definition and Validation
 * =============================================================================
 *
 * Represents a directed acyclic graph (DAG) of agent nodes.
 * Provides:
 *   - DAG validation (cycle detection via depth-first search)
 *   - Topological sort (Kahn's algorithm)
 *   - Entry/exit node identification
 *   - Execution plan generation
 *   - Reference validation (dependsOn → existing nodes)
 */

import type {
  AgentGraph,
  AgentNodeDefinition,
  ExecutionId,
  ExecutionLayer,
  ExecutionPlan,
  GraphMetadata,
  GraphName,
} from '../core/types.js';
import { CyclicGraphError, InvalidGraphError } from '../core/errors.js';
import { AgentNode } from './agent-node.js';

// ============================================================================
// AgentGraph Implementation
// ============================================================================

/**
 * Concrete implementation of the AgentGraph interface.
 * Validates the graph as a DAG on construction.
 */
export class AgentGraphImpl implements AgentGraph {
  public readonly name: GraphName;
  public readonly metadata: GraphMetadata;
  public readonly nodes: ReadonlyMap<string, AgentNodeDefinition>;
  public readonly topologicalOrder: ReadonlyArray<string>;
  public readonly entryNodes: ReadonlyArray<string>;
  public readonly exitNodes: ReadonlyArray<string>;

  private readonly _nodeMap: ReadonlyMap<string, AgentNode>;
  private readonly _validated: boolean;

  /**
   * Create a new AgentGraph and validate it.
   *
   * @param name - The graph name
   * @param metadata - Graph metadata
   * @param nodeDefinitions - All node definitions in the graph
   * @throws CyclicGraphError if the graph contains a cycle
   * @throws InvalidGraphError if the graph is structurally invalid
   */
  constructor(
    name: GraphName,
    metadata: GraphMetadata,
    nodeDefinitions: ReadonlyArray<AgentNodeDefinition>,
  ) {
    this.name = name;
    this.metadata = metadata;

    // Build the node map
    const nodesMap = new Map<string, AgentNodeDefinition>();
    const agentNodes = new Map<string, AgentNode>();
    const allNodeNames = new Set<string>();

    for (const def of nodeDefinitions) {
      if (allNodeNames.has(def.name)) {
        throw new InvalidGraphError(name as unknown as string, [
          `Duplicate node name: "${def.name}"`,
        ]);
      }
      allNodeNames.add(def.name);
      nodesMap.set(def.name, def);
      agentNodes.set(def.name, new AgentNode(def));
    }

    this.nodes = nodesMap;
    this._nodeMap = agentNodes;

    // Validate all dependency references
    this._validateReferences(allNodeNames);

    // Detect cycles
    const cycleNodes = this._detectCycles();
    if (cycleNodes.length > 0) {
      throw new CyclicGraphError(name as unknown as string, cycleNodes);
    }

    // Compute topological order
    this.topologicalOrder = this._topologicalSort();

    // Identify entry and exit nodes
    this.entryNodes = this._findEntryNodes();
    this.exitNodes = this._findExitNodes();

    this._validated = true;
  }

  // ==========================================================================
  // Validation
  // ==========================================================================

  /**
   * Validate the graph structure.
   * Already called in constructor; this is for re-validation if needed.
   *
   * @returns true if the graph is valid
   */
  validate(): boolean {
    if (!this._validated) {
      return false;
    }

    // Re-check cycles (shouldn't appear after construction, but defensive)
    const cycleNodes = this._detectCycles();
    if (cycleNodes.length > 0) {
      return false;
    }

    return true;
  }

  /**
   * Validate that all `dependsOn` references point to existing nodes.
   */
  private _validateReferences(allNodeNames: ReadonlySet<string>): void {
    const errors: string[] = [];

    for (const node of this._nodeMap.values()) {
      try {
        node.validateReferences(allNodeNames);
      } catch (error) {
        if (error instanceof InvalidGraphError) {
          errors.push(...error.validationErrors);
        } else {
          throw error;
        }
      }
    }

    if (errors.length > 0) {
      throw new InvalidGraphError(this.name as unknown as string, errors);
    }
  }

  // ==========================================================================
  // Cycle Detection (DFS-based)
  // ==========================================================================

  /**
   * Detect cycles in the graph using depth-first search with coloring.
   *
   * Color states:
   *   WHITE (0) — unvisited
   *   GRAY  (1) — in current DFS path (back edge → cycle)
   *   BLACK (2) — fully explored
   *
   * @returns Array of node names involved in a cycle, or empty if acyclic
   */
  private _detectCycles(): string[] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    const colors = new Map<string, number>();
    const parentMap = new Map<string, string | null>();

    for (const nodeName of this.nodes.keys()) {
      colors.set(nodeName, WHITE);
      parentMap.set(nodeName, null);
    }

    for (const nodeName of this.nodes.keys()) {
      if (colors.get(nodeName) === WHITE) {
        const cycle = this._dfsVisit(nodeName, colors, parentMap);
        if (cycle.length > 0) {
          return cycle;
        }
      }
    }

    return [];
  }

  /**
   * DFS visit for cycle detection.
   */
  private _dfsVisit(
    nodeName: string,
    colors: Map<string, number>,
    parentMap: Map<string, string | null>,
  ): string[] {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;

    colors.set(nodeName, GRAY);

    const nodeDef = this.nodes.get(nodeName);
    if (!nodeDef) {
      return [];
    }

    for (const dep of nodeDef.dependsOn) {
      const depColor = colors.get(dep);

      if (depColor === GRAY) {
        // Found a cycle — reconstruct the cycle path
        const cycle: string[] = [dep, nodeName];
        let current = nodeName;
        while (parentMap.get(current) !== null && parentMap.get(current) !== dep) {
          const parent = parentMap.get(current);
          if (parent) {
            cycle.push(parent);
            current = parent;
          } else {
            break;
          }
        }
        cycle.push(dep);
        return cycle.reverse();
      }

      if (depColor === WHITE) {
        parentMap.set(dep, nodeName);
        const cycle = this._dfsVisit(dep, colors, parentMap);
        if (cycle.length > 0) {
          return cycle;
        }
      }
    }

    colors.set(nodeName, BLACK);
    return [];
  }

  // ==========================================================================
  // Topological Sort (Kahn's Algorithm)
  // ==========================================================================

  /**
   * Compute topological order using Kahn's algorithm.
   * Assumes the graph is already validated as a DAG.
   *
   * @returns Topologically sorted node names
   */
  private _topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    const order: string[] = [];

    // Initialize in-degrees
    for (const nodeName of this.nodes.keys()) {
      inDegree.set(nodeName, 0);
    }

    for (const nodeDef of this.nodes.values()) {
      for (const dep of nodeDef.dependsOn) {
        const current = inDegree.get(dep) ?? 0;
        inDegree.set(dep, current);
      }
    }

    // Need to recalculate: inDegree for a node = number of nodes that depend on it
    // Wait, for topological sort we need inDegree = number of dependencies a node has
    // Let me redo this correctly:
    for (const nodeName of this.nodes.keys()) {
      inDegree.set(nodeName, 0);
    }

    for (const nodeDef of this.nodes.values()) {
      for (const dep of nodeDef.dependsOn) {
        // The dependent node has an incoming edge from dep
        // So nodeDef.name's inDegree increases
        // No, wait. dependsOn means "this node depends on dep"
        // So the edge is dep → nodeDef.name
        // nodeDef.name has an incoming edge, so its inDegree increases
        const current = inDegree.get(nodeDef.name) ?? 0;
        inDegree.set(nodeDef.name, current + 1);
      }
    }

    // Kahn's algorithm: work queue of nodes with in-degree 0
    const queue: string[] = [];
    for (const [nodeName, degree] of inDegree) {
      if (degree === 0) {
        queue.push(nodeName);
      }
    }

    while (queue.length > 0) {
      // Sort for deterministic ordering
      queue.sort();
      const nodeName = queue.shift()!;
      order.push(nodeName);

      // Reduce in-degree of all nodes that depend on this node
      for (const [otherName, otherDef] of this.nodes) {
        if (otherDef.dependsOn.includes(nodeName)) {
          const newDegree = (inDegree.get(otherName) ?? 1) - 1;
          inDegree.set(otherName, newDegree);
          if (newDegree === 0) {
            queue.push(otherName);
          }
        }
      }
    }

    return order;
  }

  // ==========================================================================
  // Entry / Exit Nodes
  // ==========================================================================

  /**
   * Find entry nodes (nodes with no dependencies).
   */
  private _findEntryNodes(): string[] {
    const entryNodes: string[] = [];
    for (const nodeDef of this.nodes.values()) {
      if (nodeDef.dependsOn.length === 0) {
        entryNodes.push(nodeDef.name);
      }
    }
    return entryNodes;
  }

  /**
   * Find exit nodes (nodes that nothing depends on).
   */
  private _findExitNodes(): string[] {
    const hasDependent = new Set<string>();
    for (const nodeDef of this.nodes.values()) {
      for (const dep of nodeDef.dependsOn) {
        hasDependent.add(dep);
      }
    }

    const exitNodes: string[] = [];
    for (const nodeName of this.nodes.keys()) {
      if (!hasDependent.has(nodeName)) {
        exitNodes.push(nodeName);
      }
    }
    return exitNodes;
  }

  // ==========================================================================
  // Execution Plan
  // ==========================================================================

  /**
   * Generate an execution plan for this graph.
   * Groups nodes into layers where nodes in the same layer can execute in parallel.
   *
   * @param executionId - The execution ID for this plan
   * @returns An ExecutionPlan
   */
  plan(executionId: ExecutionId): ExecutionPlan {
    // Compute layers using the topological order
    // A node belongs to layer max(dep layers) + 1, entry nodes are layer 0
    const nodeLayers = new Map<string, number>();

    for (const nodeName of this.topologicalOrder) {
      const nodeDef = this.nodes.get(nodeName);
      if (!nodeDef || nodeDef.dependsOn.length === 0) {
        nodeLayers.set(nodeName, 0);
      } else {
        let maxDepLayer = -1;
        for (const dep of nodeDef.dependsOn) {
          const depLayer = nodeLayers.get(dep) ?? 0;
          maxDepLayer = Math.max(maxDepLayer, depLayer);
        }
        nodeLayers.set(nodeName, maxDepLayer + 1);
      }
    }

    // Group nodes by layer
    const layerMap = new Map<number, AgentNodeDefinition[]>();
    for (const nodeName of this.topologicalOrder) {
      const layer = nodeLayers.get(nodeName) ?? 0;
      const nodeDef = this.nodes.get(nodeName);
      if (nodeDef) {
        const layerNodes = layerMap.get(layer) ?? [];
        layerNodes.push(nodeDef);
        layerMap.set(layer, layerNodes);
      }
    }

    // Convert to ExecutionLayer array
    const layers: ExecutionLayer[] = [];
    const maxLayer = Math.max(...layerMap.keys(), 0);
    for (let i = 0; i <= maxLayer; i++) {
      const nodes = layerMap.get(i) ?? [];
      layers.push({
        index: i,
        nodes,
      });
    }

    return {
      graphName: this.name,
      executionId,
      layers,
      totalNodes: this.nodes.size,
      excludedNodes: [], // Pre-computed conditions could populate this
      createdAt: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  /**
   * Get an AgentNode wrapper by name.
   *
   * @param nodeName - The node name
   * @returns The AgentNode, or undefined
   */
  getNode(nodeName: string): AgentNode | undefined {
    return this._nodeMap.get(nodeName);
  }

  /**
   * Get all AgentNode wrappers.
   */
  get agentNodes(): ReadonlyArray<AgentNode> {
    return [...this._nodeMap.values()];
  }

  /**
   * Check if this graph has any nodes.
   */
  get isEmpty(): boolean {
    return this.nodes.size === 0;
  }

  /**
   * Get the total number of nodes.
   */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Get the total number of edges (dependency relationships).
   */
  get edgeCount(): number {
    let count = 0;
    for (const nodeDef of this.nodes.values()) {
      count += nodeDef.dependsOn.length;
    }
    return count;
  }
}
