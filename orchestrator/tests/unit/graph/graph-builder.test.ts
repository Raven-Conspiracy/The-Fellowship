/**
 * Graph Builder — Unit Tests
 *
 * Tests for the `GraphBuilder` fluent API: node registration,
 * cycle detection, graph validation, and DAG topology checks.
 */

import { describe, it, expect } from "vitest";
import { createMockLogger } from "../../mocks/logger.mock.js";
import type { MockLogger } from "../../mocks/logger.mock.js";

// Minimal GraphBuilder mirroring what Builder Agent 1 will create
// In production: import from ../../src/graph/graph-builder.js

type AgentName = string & { readonly __brand: "AgentName" };
type NodeId = string & { readonly __brand: "NodeId" };
type GraphName = string & { readonly __brand: "GraphName" };

interface Condition {
  type: string;
  expression: string;
}

interface NodeConfig {
  dependsOn?: string[];
  condition?: Condition;
  inputMapping?: string[];
  retryPolicy?: { maxAttempts: number; backoffBaseMs: number; maxBackoffMs: number };
  timeoutMs?: number;
}

class GraphValidationError extends Error {
  public readonly code = "GRAPH_VALIDATION_ERROR";
  public readonly retryable = false;
  constructor(message: string, opts?: Record<string, unknown>) {
    super(message);
  }
}

class GraphCycleError extends GraphValidationError {
  public readonly code = "GRAPH_CYCLE_ERROR";
  constructor(message: string, opts?: Record<string, unknown>) {
    super(message, opts);
  }
}

interface AgentNode {
  id: NodeId;
  agentName: AgentName;
  dependsOn: NodeId[];
  condition?: Condition;
}

interface AgentGraph {
  graphName: GraphName;
  nodes: Map<NodeId, AgentNode>;
  validate(): { isOk(): boolean; isErr(): boolean; error?: Error };
}

class GraphBuilder {
  private readonly graphName: GraphName;
  private readonly nodes: Map<NodeId, AgentNode> = new Map();
  private readonly logger: MockLogger;

  constructor(graphName: GraphName, logger: MockLogger) {
    this.graphName = graphName;
    this.logger = logger;
  }

  node(id: string, agentName: string, config?: NodeConfig): this {
    const nodeId = id as NodeId;
    if (this.nodes.has(nodeId)) {
      throw new GraphValidationError(`Duplicate node ID: ${id}`);
    }

    this.nodes.set(nodeId, {
      id: nodeId,
      agentName: agentName as AgentName,
      dependsOn: (config?.dependsOn ?? []) as NodeId[],
      condition: config?.condition,
    });

    return this;
  }

  build(): AgentGraph {
    const graph: AgentGraph = {
      graphName: this.graphName,
      nodes: new Map(this.nodes),
      validate: () => {
        const cycleResult = this.detectCycles();
        if (cycleResult) {
          return { isOk: () => false, isErr: () => true, error: new GraphCycleError(cycleResult) };
        }

        const orphanResult = this.checkOrphanNodes();
        if (orphanResult) {
          return { isOk: () => false, isErr: () => true, error: new GraphValidationError(orphanResult) };
        }

        if (this.nodes.size === 0) {
          return { isOk: () => false, isErr: () => true, error: new GraphValidationError("Graph must have at least one node") };
        }

        return { isOk: () => true, isErr: () => false };
      },
    };
    return graph;
  }

  private detectCycles(): string | null {
    const visited = new Set<NodeId>();
    const recursionStack = new Set<NodeId>();

    function dfs(nodeId: NodeId, nodes: Map<NodeId, AgentNode>): string | null {
      visited.add(nodeId);
      recursionStack.add(nodeId);

      const node = nodes.get(nodeId);
      if (node) {
        for (const dep of node.dependsOn) {
          if (!visited.has(dep)) {
            const result = dfs(dep, nodes);
            if (result) return result;
          } else if (recursionStack.has(dep)) {
            return `Cycle detected involving nodes: ${nodeId} → ${dep}`;
          }
        }
      }

      recursionStack.delete(nodeId);
      return null;
    }

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        const result = dfs(nodeId, this.nodes);
        if (result) return result;
      }
    }

    return null;
  }

  private checkOrphanNodes(): string | null {
    const allIds = new Set(this.nodes.keys());
    const referenced = new Set<NodeId>();

    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        referenced.add(dep);
      }
    }

    // Nodes with no dependencies and never referenced are legitimate root nodes
    // But nodes referenced that don't exist are a problem
    for (const dep of referenced) {
      if (!allIds.has(dep)) {
        return `Node "${dep}" is referenced as a dependency but does not exist`;
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphBuilder", () => {
  let logger: MockLogger;

  function createBuilder(name = "test-graph"): GraphBuilder {
    logger = createMockLogger();
    return new GraphBuilder(name as GraphName, logger);
  }

  describe("fluent API", () => {
    it("should add nodes via the fluent interface", () => {
      const graph = createBuilder()
        .node("a", "agent-a")
        .node("b", "agent-b", { dependsOn: ["a"] })
        .build();

      expect(graph.graphName).toBe("test-graph");
      expect(graph.nodes.size).toBe(2);
    });

    it("should support method chaining", () => {
      const graph = createBuilder()
        .node("a", "agent-a")
        .node("b", "agent-b", { dependsOn: ["a"] })
        .node("c", "agent-c", { dependsOn: ["b"] })
        .build();

      expect(graph.nodes.size).toBe(3);
    });

    it("should throw on duplicate node ID", () => {
      expect(() =>
        createBuilder()
          .node("a", "agent-a")
          .node("a", "agent-b"),
      ).toThrow(GraphValidationError);
    });
  });

  describe("cycle detection", () => {
    it("should detect a simple cycle (A→B→A)", () => {
      const graph = createBuilder()
        .node("a", "agent-a", { dependsOn: ["b"] })
        .node("b", "agent-b", { dependsOn: ["a"] })
        .build();

      const result = graph.validate();
      expect(result.isErr()).toBe(true);
      expect(result.error).toBeInstanceOf(GraphCycleError);
    });

    it("should detect a 3-node cycle", () => {
      const graph = createBuilder()
        .node("a", "agent-a", { dependsOn: ["c"] })
        .node("b", "agent-b", { dependsOn: ["a"] })
        .node("c", "agent-c", { dependsOn: ["b"] })
        .build();

      const result = graph.validate();
      expect(result.isErr()).toBe(true);
      expect(result.error).toBeInstanceOf(GraphCycleError);
    });

    it("should detect a self-loop", () => {
      const graph = createBuilder()
        .node("a", "agent-a", { dependsOn: ["a"] })
        .build();

      const result = graph.validate();
      expect(result.isErr()).toBe(true);
    });

    it("should pass for a valid DAG", () => {
      const graph = createBuilder()
        .node("a", "agent-a")
        .node("b", "agent-b", { dependsOn: ["a"] })
        .node("c", "agent-c", { dependsOn: ["a"] })
        .node("d", "agent-d", { dependsOn: ["b", "c"] })
        .build();

      const result = graph.validate();
      expect(result.isOk()).toBe(true);
    });
  });

  describe("validation", () => {
    it("should reject an empty graph", () => {
      const graph = createBuilder().build();
      const result = graph.validate();
      expect(result.isErr()).toBe(true);
    });

    it("should reject orphan references (dependency to non-existent node)", () => {
      const graph = createBuilder()
        .node("a", "agent-a", { dependsOn: ["nonexistent"] })
        .build();

      const result = graph.validate();
      expect(result.isErr()).toBe(true);
    });

    it("should accept independent root nodes (no dependencies)", () => {
      const graph = createBuilder()
        .node("a", "agent-a")
        .node("b", "agent-b")
        .node("c", "agent-c")
        .build();

      const result = graph.validate();
      expect(result.isOk()).toBe(true);
    });

    it("should accept a diamond topology", () => {
      // A → (B, C) → D
      const graph = createBuilder()
        .node("a", "agent-a")
        .node("b", "agent-b", { dependsOn: ["a"] })
        .node("c", "agent-c", { dependsOn: ["a"] })
        .node("d", "agent-d", { dependsOn: ["b", "c"] })
        .build();

      const result = graph.validate();
      expect(result.isOk()).toBe(true);
    });
  });
});
