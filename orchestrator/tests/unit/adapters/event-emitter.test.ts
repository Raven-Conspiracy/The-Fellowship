/**
 * Event Emitter — Unit Tests
 *
 * Tests for the `EventEmitter`: event format validation, event type
 * correctness, payload structure, and fire-and-forget semantics.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockEventEmitter } from "../../mocks/foundry.mock.js";
import type { MockEventEmitter } from "../../mocks/foundry.mock.js";

describe("EventEmitter", () => {
  let emitter: MockEventEmitter;

  beforeEach(() => {
    emitter = createMockEventEmitter();
  });

  describe("graph lifecycle events", () => {
    it("should emit graph.started", async () => {
      await emitter.emitGraphStarted("exec-1", "test-graph", 4, { key: "value" });

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("graph.started");
      expect(events[0]!.args[0]).toBe("exec-1");
      expect(events[0]!.args[1]).toBe("test-graph");
      expect(events[0]!.args[2]).toBe(4);
    });

    it("should emit graph.completed", async () => {
      const mockResult: any = {
        executionId: "exec-1",
        graphName: "test-graph",
        status: "completed",
        nodeResults: [],
      };

      await emitter.emitGraphCompleted(mockResult, 5000);

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("graph.completed");
    });

    it("should emit graph.error", async () => {
      const mockError: any = { code: "TEST_ERR", message: "Graph failed", retryable: false };

      await emitter.emitGraphError("exec-1", "test-graph", mockError, 3000);

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("graph.error");
    });
  });

  describe("node lifecycle events", () => {
    it("should emit node.started", async () => {
      await emitter.emitNodeStarted("exec-1", "test-graph", "node-a", "classifier");

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("node.started");
      expect(events[0]!.args[2]).toBe("node-a");
      expect(events[0]!.args[3]).toBe("classifier");
    });

    it("should emit node.completed", async () => {
      const mockResult: any = {
        nodeId: "node-a",
        agentName: "classifier",
        status: "success",
        data: { confidence: 0.95 },
      };

      await emitter.emitNodeCompleted("exec-1", "test-graph", "node-a", "classifier", mockResult, 150);

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("node.completed");
    });

    it("should emit node.error", async () => {
      const mockError: any = { code: "NETWORK_ERROR", message: "Connection refused", retryable: true };

      await emitter.emitNodeError("exec-1", "test-graph", "node-a", "classifier", mockError, 250);

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("node.error");
    });

    it("should emit node.skipped", async () => {
      await emitter.emitNodeSkipped("exec-1", "test-graph", "node-c", "escalator", "Condition not met: confidence >= 0.7");

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.eventType).toBe("node.skipped");
    });
  });

  describe("event tracking", () => {
    it("should track multiple events in order", async () => {
      await emitter.emitGraphStarted("exec-1", "test-graph", 2);
      await emitter.emitNodeStarted("exec-1", "test-graph", "node-a", "agent-a");
      await emitter.emitNodeCompleted("exec-1", "test-graph", "node-a", "agent-a", {} as any, 100);
      await emitter.emitGraphCompleted({ executionId: "exec-1", graphName: "test-graph" } as any, 200);

      const events = emitter.getEmittedEvents();
      expect(events).toHaveLength(4);
      expect(events.map((e) => e.eventType)).toEqual([
        "graph.started",
        "node.started",
        "node.completed",
        "graph.completed",
      ]);
    });
  });

  describe("vitest mock integration", () => {
    it("should have been called with correct arguments", async () => {
      await emitter.emitNodeStarted("exec-1", "test-graph", "node-a", "agent-a");

      expect(emitter.emitNodeStarted).toHaveBeenCalledWith("exec-1", "test-graph", "node-a", "agent-a");
      expect(emitter.emitNodeStarted).toHaveBeenCalledTimes(1);
    });

    it("should reset properly", () => {
      emitter.reset();
      expect(emitter.getEmittedEvents()).toHaveLength(0);
      expect(emitter.emitNodeStarted).not.toHaveBeenCalled();
    });
  });
});
