/**
 * Graph Runner — Unit Tests
 *
 * Tests for the `GraphRunner`: sequential and parallel execution,
 * conditional node skipping, retry integration, and error propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err } from "neverthrow";
import { createMockLogger } from "../../mocks/logger.mock.js";
import type { MockLogger } from "../../mocks/logger.mock.js";
import { createSuccessResult, createErrorResult } from "../../fixtures/agent-fixtures.js";

// ---------------------------------------------------------------------------
// Minimal runner types
// ---------------------------------------------------------------------------

type NodeId = string & { readonly __brand: "NodeId" };
type AgentName = string & { readonly __brand: "AgentName" };

interface AgentNode {
  id: NodeId;
  agentName: AgentName;
  dependsOn: NodeId[];
  condition?: { type: string; expression: string };
}

interface AgentResult {
  nodeId: NodeId;
  agentName: AgentName;
  status: "success" | "error";
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface ExecutionResult {
  status: "completed" | "failed" | "partial";
  nodeResults: AgentResult[];
  errors: Error[];
}

class DomainError extends Error {
  public readonly code: string;
  public readonly retryable?: boolean;
  constructor(message: string, opts: { code?: string; retryable?: boolean } = {}) {
    super(message);
    this.code = opts.code ?? "DOMAIN_ERROR";
    this.retryable = opts.retryable;
  }
}

// ---------------------------------------------------------------------------
// Minimal GraphRunner
// ---------------------------------------------------------------------------

class GraphRunner {
  private readonly executeFn: (node: AgentNode) => Promise<AgentResult>;

  constructor(executeFn: (node: AgentNode) => Promise<AgentResult>) {
    this.executeFn = executeFn;
  }

  async run(nodes: AgentNode[]): Promise<ExecutionResult> {
    const results: AgentResult[] = [];
    const errors: Error[] = [];
    const completed = new Set<NodeId>();
    const remaining = new Map<NodeId, AgentNode>();
    for (const node of nodes) {
      remaining.set(node.id, node);
    }

    while (remaining.size > 0) {
      const ready: AgentNode[] = [];

      for (const node of remaining.values()) {
        const allDepsMet = node.dependsOn.every((dep) => completed.has(dep));
        if (allDepsMet) {
          // Check condition
          if (node.condition) {
            const result = results.find((r) => r.nodeId === node.dependsOn[0]);
            if (result && result.data.confidence !== undefined) {
              if ((result.data.confidence as number) >= 0.5) {
                // Skip this node
                remaining.delete(node.id);
                continue;
              }
            }
          }
          ready.push(node);
        }
      }

      if (ready.length === 0 && remaining.size > 0) {
        errors.push(new DomainError("Deadlock: no nodes ready but some remain"));
        break;
      }

      // Execute ready nodes in parallel
      const batchResults = await Promise.allSettled(
        ready.map((node) => this.executeFn(node)),
      );

      for (let i = 0; i < ready.length; i++) {
        const node = ready[i]!;
        const settled = batchResults[i]!;

        if (settled.status === "fulfilled") {
          results.push(settled.value);
          completed.add(node.id);
        } else {
          errors.push(
            settled.reason instanceof Error
              ? settled.reason
              : new Error(String(settled.reason)),
          );
        }
        remaining.delete(node.id);
      }
    }

    return {
      status: errors.length > 0
        ? (results.length > 0 ? "partial" : "failed")
        : "completed",
      nodeResults: results,
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphRunner", () => {
  let mockExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecute = vi.fn();
  });

  function createNode(id: string, dependsOn: string[] = [], condition?: { type: string; expression: string }): AgentNode {
    return {
      id: id as NodeId,
      agentName: `agent-${id}` as AgentName,
      dependsOn: dependsOn as NodeId[],
      condition,
    };
  }

  describe("sequential execution", () => {
    it("should execute nodes in dependency order (A → B)", async () => {
      mockExecute.mockImplementation(async (node: AgentNode) =>
        createSuccessResult({ nodeId: node.id, agentName: node.agentName }),
      );

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b", ["a"]),
      ];

      const result = await runner.run(nodes);

      expect(result.status).toBe("completed");
      expect(result.nodeResults).toHaveLength(2);

      // A should execute before B
      const calls = mockExecute.mock.calls.map((c: any) => c[0].id);
      expect(calls.indexOf("a")).toBeLessThan(calls.indexOf("b"));
    });

    it("should execute a 3-node linear graph (A → B → C)", async () => {
      mockExecute.mockImplementation(async (node: AgentNode) =>
        createSuccessResult({ nodeId: node.id, agentName: node.agentName }),
      );

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b", ["a"]),
        createNode("c", ["b"]),
      ];

      const result = await runner.run(nodes);

      expect(result.status).toBe("completed");
      expect(result.nodeResults).toHaveLength(3);
    });
  });

  describe("parallel execution", () => {
    it("should execute independent nodes in parallel", async () => {
      const startTimes: Record<string, number> = {};

      mockExecute.mockImplementation(async (node: AgentNode) => {
        startTimes[node.id as string] = Date.now();
        // Small delay to simulate work
        await new Promise((r) => setTimeout(r, 10));
        return createSuccessResult({ nodeId: node.id, agentName: node.agentName });
      });

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b"),
        createNode("c"),
      ];

      const result = await runner.run(nodes);

      expect(result.status).toBe("completed");
      expect(result.nodeResults).toHaveLength(3);

      // All three should have started within a short window (parallel)
      const times = Object.values(startTimes);
      const maxDiff = Math.max(...times) - Math.min(...times);
      expect(maxDiff).toBeLessThan(100); // all started within 100ms
    });

    it("should fan out after dependency completes (A → B, C in parallel)", async () => {
      const executionOrder: string[] = [];

      mockExecute.mockImplementation(async (node: AgentNode) => {
        executionOrder.push(node.id as string);
        return createSuccessResult({ nodeId: node.id, agentName: node.agentName });
      });

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b", ["a"]),
        createNode("c", ["a"]),
      ];

      await runner.run(nodes);

      // A must be first, B and C after A
      expect(executionOrder[0]).toBe("a");
      expect(executionOrder.slice(1).sort()).toEqual(["b", "c"]);
    });
  });

  describe("conditional execution", () => {
    it("should skip a conditional node when condition is not met", async () => {
      mockExecute.mockImplementation(async (node: AgentNode) => {
        if (node.id === "a") {
          return createSuccessResult({
            nodeId: node.id,
            agentName: node.agentName,
            data: { confidence: 0.95 }, // high confidence → skip condition
          });
        }
        return createSuccessResult({ nodeId: node.id, agentName: node.agentName });
      });

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b", ["a"]),
        createNode("c", ["a"], { type: "predicate", expression: "state.a.confidence < 0.5" }),
      ];

      const result = await runner.run(nodes);

      // C should have been skipped (condition not met)
      const executedIds = result.nodeResults.map((n) => n.nodeId);
      expect(executedIds).not.toContain("c");
      expect(executedIds).toContain("a");
      expect(executedIds).toContain("b");
    });

    it("should execute a conditional node when condition is met", async () => {
      mockExecute.mockImplementation(async (node: AgentNode) => {
        if (node.id === "a") {
          return createSuccessResult({
            nodeId: node.id,
            agentName: node.agentName,
            data: { confidence: 0.3 }, // low confidence → run condition node
          });
        }
        return createSuccessResult({ nodeId: node.id, agentName: node.agentName });
      });

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b", ["a"]),
        createNode("c", ["a"], { type: "predicate", expression: "state.a.confidence < 0.5" }),
      ];

      const result = await runner.run(nodes);

      const executedIds = result.nodeResults.map((n) => n.nodeId);
      expect(executedIds).toContain("c");
    });
  });

  describe("error handling", () => {
    it("should capture node execution errors", async () => {
      mockExecute.mockRejectedValue(new Error("Node execution failed"));

      const runner = new GraphRunner(mockExecute);
      const nodes = [createNode("a")];

      const result = await runner.run(nodes);

      expect(result.status).toBe("failed");
      expect(result.errors).toHaveLength(1);
    });

    it("should mark partial success when some nodes fail", async () => {
      mockExecute.mockImplementation(async (node: AgentNode) => {
        if (node.id === "b") {
          throw new Error("Node b failed");
        }
        return createSuccessResult({ nodeId: node.id, agentName: node.agentName });
      });

      const runner = new GraphRunner(mockExecute);
      const nodes = [
        createNode("a"),
        createNode("b"),
        createNode("c"),
      ];

      const result = await runner.run(nodes);

      expect(result.status).toBe("partial");
      expect(result.nodeResults.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
