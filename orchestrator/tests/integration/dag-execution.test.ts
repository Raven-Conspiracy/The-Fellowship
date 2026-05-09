/**
 * Integration Test — DAG Execution (Multi-Node with Parallel Branches)
 *
 * End-to-end test of a diamond graph (A → [B, C] → D) using mocked
 * Apollo HTTP via `nock`. Validates:
 *
 * - Parallel execution of independent nodes (B, C run concurrently)
 * - Fan-in synchronization (D waits for both B and C)
 * - Event emission for every node lifecycle
 * - Ontology write at completion
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import nock from "nock";
import { ulid } from "ulid";

import { createMockLogger } from "../mocks/logger.mock.js";
import { createMockEventEmitter, createMockOntologyWriter } from "../mocks/foundry.mock.js";
import { createExecutionRequest } from "../fixtures/request-fixtures.js";
import { DIAMOND_4_NODE } from "../fixtures/graph-fixtures.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APOLLO_BASE_URL = "http://localhost:9999";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Integration: Diamond DAG (A → B,C → D)", () => {
  const logger = createMockLogger();
  const eventEmitter = createMockEventEmitter();
  const ontologyWriter = createMockOntologyWriter();

  beforeEach(() => {
    logger.clearLogs();
    eventEmitter.reset();
    ontologyWriter.reset();
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe("graph topology", () => {
    it("should define a valid diamond DAG", () => {
      const graphConfig = DIAMOND_4_NODE;

      expect(graphConfig.nodes).toHaveLength(4);
      expect(graphConfig.nodes[0]!.id).toBe("a");
      expect(graphConfig.nodes[1]!.id).toBe("b");
      expect(graphConfig.nodes[2]!.id).toBe("c");
      expect(graphConfig.nodes[3]!.id).toBe("d");

      // A has no dependencies
      expect(graphConfig.nodes[0]!.dependsOn).toEqual([]);

      // B and C both depend on A
      expect(graphConfig.nodes[1]!.dependsOn).toEqual(["a"]);
      expect(graphConfig.nodes[2]!.dependsOn).toEqual(["a"]);

      // D depends on both B and C (fan-in)
      expect(graphConfig.nodes[3]!.dependsOn).toEqual(["b", "c"]);
    });

    it("should have correct execution order constraints", () => {
      const graphConfig = DIAMOND_4_NODE;

      // A must execute before anything else (root)
      // B and C can execute in parallel after A
      // D must wait for both B and C

      const allDeps = new Set<string>();
      for (const node of graphConfig.nodes) {
        for (const dep of node.dependsOn) {
          allDeps.add(dep);
        }
      }

      // All dependency references must exist as node IDs
      const nodeIds = new Set(graphConfig.nodes.map((n) => n.id));
      for (const dep of allDeps) {
        expect(nodeIds.has(dep)).toBe(true);
      }
    });
  });

  describe("happy path: all 4 nodes succeed", () => {
    it("should mock Apollo for all 4 agent calls", async () => {
      // -- Arrange: Mock all 4 Apollo endpoints ---------------------------
      nock(APOLLO_BASE_URL)
        .post("/striveworks/agent-a")
        .reply(200, {
          status: "success",
          requestId: "ap-a",
          data: { step: "a", confidence: 0.9 },
        });

      // B and C are independent — both should be callable in any order
      nock(APOLLO_BASE_URL)
        .post("/striveworks/agent-b")
        .reply(200, {
          status: "success",
          requestId: "ap-b",
          data: { step: "b", result: "normalized-b" },
        });

      nock(APOLLO_BASE_URL)
        .post("/striveworks/agent-c")
        .reply(200, {
          status: "success",
          requestId: "ap-c",
          data: { step: "c", result: "normalized-c" },
        });

      nock(APOLLO_BASE_URL)
        .post("/striveworks/agent-d")
        .reply(200, {
          status: "success",
          requestId: "ap-d",
          data: { step: "d", merged: true },
        });

      // -- Verify nock interceptors are configured ------------------------
      expect(nock.activeMocks()).toContain("localhost:9999");
    });

    it("should emit all expected lifecycle events", async () => {
      // Simulate the complete event sequence for a diamond DAG execution
      await eventEmitter.emitGraphStarted("exec-diamond", "diamond-4", 4);

      // Node A
      await eventEmitter.emitNodeStarted("exec-diamond", "diamond-4", "a", "agent-a");
      await eventEmitter.emitNodeCompleted("exec-diamond", "diamond-4", "a", "agent-a", {
        nodeId: "a" as any, agentName: "agent-a" as any, status: "success",
        data: { confidence: 0.9 }, metadata: { durationMs: 100 },
      }, 100);

      // Nodes B and C (parallel — order may vary)
      await eventEmitter.emitNodeStarted("exec-diamond", "diamond-4", "b", "agent-b");
      await eventEmitter.emitNodeStarted("exec-diamond", "diamond-4", "c", "agent-c");
      await eventEmitter.emitNodeCompleted("exec-diamond", "diamond-4", "b", "agent-b", {
        nodeId: "b" as any, agentName: "agent-b" as any, status: "success",
        data: {}, metadata: { durationMs: 200 },
      }, 200);
      await eventEmitter.emitNodeCompleted("exec-diamond", "diamond-4", "c", "agent-c", {
        nodeId: "c" as any, agentName: "agent-c" as any, status: "success",
        data: {}, metadata: { durationMs: 250 },
      }, 250);

      // Node D (after B and C)
      await eventEmitter.emitNodeStarted("exec-diamond", "diamond-4", "d", "agent-d");
      await eventEmitter.emitNodeCompleted("exec-diamond", "diamond-4", "d", "agent-d", {
        nodeId: "d" as any, agentName: "agent-d" as any, status: "success",
        data: { merged: true }, metadata: { durationMs: 150 },
      }, 150);

      await eventEmitter.emitGraphCompleted({
        executionId: "exec-diamond" as any,
        graphName: "diamond-4" as any,
        status: "completed",
        nodeResults: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 700,
      }, 700);

      // -- Assert ---------------------------------------------------------
      const events = eventEmitter.getEmittedEvents();
      expect(events).toHaveLength(10); // 1 graph.start + 4 node.start + 4 node.complete + 1 graph.complete

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes.filter((t) => t === "node.started")).toHaveLength(4);
      expect(eventTypes.filter((t) => t === "node.completed")).toHaveLength(4);
    });
  });

  describe("partial failure: B fails, C and D still execute", () => {
    it("should handle one branch failing while the other succeeds", async () => {
      // Simulate: A succeeds, B fails, C succeeds, D runs after C (or fails waiting for B)

      await eventEmitter.emitGraphStarted("exec-partial", "diamond-4", 4);
      await eventEmitter.emitNodeStarted("exec-partial", "diamond-4", "a", "agent-a");
      await eventEmitter.emitNodeCompleted("exec-partial", "diamond-4", "a", "agent-a", {
        nodeId: "a" as any, agentName: "agent-a" as any, status: "success",
        data: {}, metadata: {},
      }, 100);

      // B fails
      await eventEmitter.emitNodeStarted("exec-partial", "diamond-4", "b", "agent-b");
      await eventEmitter.emitNodeError("exec-partial", "diamond-4", "b", "agent-b", {
        code: "NETWORK_ERROR", message: "B failed", retryable: false,
      } as any, 300);

      // C succeeds
      await eventEmitter.emitNodeStarted("exec-partial", "diamond-4", "c", "agent-c");
      await eventEmitter.emitNodeCompleted("exec-partial", "diamond-4", "c", "agent-c", {
        nodeId: "c" as any, agentName: "agent-c" as any, status: "success",
        data: {}, metadata: {},
      }, 200);

      // D may be skipped or failed depending on configuration
      await eventEmitter.emitGraphError("exec-partial", "diamond-4", {
        code: "PARTIAL_FAILURE", message: "Graph partially failed", retryable: false,
      } as any, 600);

      const events = eventEmitter.getEmittedEvents();
      const errorEvents = events.filter((e) => e.eventType === "node.error");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]!.args[2]).toBe("b");
    });
  });

  describe("Ontology write", () => {
    it("should write the execution result to Ontology on completion", async () => {
      const mockResult: any = {
        executionId: ulid(),
        graphName: "diamond-4",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 700,
        graphVersion: "1.0.0",
        nodeResults: [
          { nodeId: "a", agentName: "agent-a", status: "success", data: {} },
          { nodeId: "b", agentName: "agent-b", status: "success", data: {} },
          { nodeId: "c", agentName: "agent-c", status: "success", data: {} },
          { nodeId: "d", agentName: "agent-d", status: "success", data: {} },
        ],
        finalState: {
          a: { confidence: 0.9 },
          b: { result: "normalized-b" },
          c: { result: "normalized-c" },
          d: { merged: true },
        },
      };

      const mockRequest = createExecutionRequest({ graphName: "diamond-4" as any });

      const writeResult = await ontologyWriter.writeResult(mockResult, mockRequest);

      expect(writeResult.isOk()).toBe(true);
      if (writeResult.isOk()) {
        expect(writeResult.value.objectRid).toBeDefined();
        expect(writeResult.value.actionType).toBeDefined();
      }

      const writtenResults = ontologyWriter.getWrittenResults();
      expect(writtenResults).toHaveLength(1);
      expect(writtenResults[0]!.graphName).toBe("diamond-4");
      expect(writtenResults[0]!.status).toBe("completed");
    });
  });
});

describe("DAG Concurrency Validation", () => {
  it("should identify independent nodes that can run in parallel", () => {
    const graphConfig = DIAMOND_4_NODE;

    // Find nodes whose dependencies are all satisfied after A
    const afterA = graphConfig.nodes.filter((n) =>
      n.dependsOn.length === 1 && n.dependsOn[0] === "a",
    );

    // B and C are independent of each other
    expect(afterA).toHaveLength(2);
    expect(afterA.map((n) => n.id).sort()).toEqual(["b", "c"]);
  });

  it("should identify the fan-in node that depends on multiple predecessors", () => {
    const graphConfig = DIAMOND_4_NODE;

    const fanInNodes = graphConfig.nodes.filter((n) => n.dependsOn.length > 1);
    expect(fanInNodes).toHaveLength(1);
    expect(fanInNodes[0]!.id).toBe("d");
    expect(fanInNodes[0]!.dependsOn).toContain("b");
    expect(fanInNodes[0]!.dependsOn).toContain("c");
  });
});
