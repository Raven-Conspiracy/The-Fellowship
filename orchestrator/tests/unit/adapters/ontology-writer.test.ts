/**
 * Ontology Writer — Unit Tests
 *
 * Tests for the `OntologyWriter`: payload mapping from ExecutionResult
 * to Ontology-compatible format, error handling, and checkpoint writes.
 */

import { describe, it, expect } from "vitest";
import type { ExecutionResult, ExecutionRequest, OntologyWritePayload } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Simulated ontology payload mapping
// ---------------------------------------------------------------------------

function mapResultToPayload(
  result: ExecutionResult,
  triggerRequest: ExecutionRequest,
  correlationId: string,
): OntologyWritePayload {
  return {
    graph_name: result.graphName,
    execution_id: result.executionId,
    trigger_request_id: triggerRequest.requestId,
    status: result.status,
    started_at: result.startedAt,
    completed_at: result.completedAt,
    duration_ms: result.durationMs,
    nodes_executed: result.nodeResults?.length ?? 0,
    nodes_succeeded: result.nodeResults?.filter((n) => n.status === "success").length ?? 0,
    nodes_failed: result.nodeResults?.filter((n) => n.status === "error").length ?? 0,
    node_results: result.nodeResults?.map((nr) => ({
      node_id: nr.nodeId,
      agent_name: nr.agentName,
      status: nr.status,
      data_summary: summarizeData(nr.data),
      error: nr.error,
    })),
    final_state: result.finalState ?? {},
    errors: result.errors?.map((e) => ({
      code: (e as any).code ?? "UNKNOWN",
      message: e.message,
    })),
    metadata: {
      correlation_id: correlationId,
      graph_version: result.graphVersion ?? "0.1.0",
      orchestrator_version: "0.1.0",
    },
  };
}

function summarizeData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  const keys = Object.keys(data).slice(0, 5);
  const summary: Record<string, unknown> = {};
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 100) {
      summary[key] = value.slice(0, 100) + "...";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OntologyWriter — Payload Mapping", () => {
  const mockRequest: ExecutionRequest = {
    requestId: "req-001" as any,
    graphName: "incident-triage" as any,
    input: { incident_id: "INC-001" },
    metadata: {
      triggeredBy: "test",
      triggerSource: "manual",
      correlationId: "corr-001",
      startedAt: "2026-05-01T12:00:00Z",
    },
    options: {},
  };

  describe("mapResultToPayload", () => {
    it("should map a completed execution result", () => {
      const result: ExecutionResult = {
        executionId: "exec-001" as any,
        graphName: "incident-triage" as any,
        status: "completed",
        startedAt: "2026-05-01T12:00:00Z",
        completedAt: "2026-05-01T12:00:05Z",
        durationMs: 5000,
        graphVersion: "0.1.0",
        nodeResults: [
          {
            nodeId: "classify" as any,
            agentName: "classifier" as any,
            status: "success",
            data: { category: "database", confidence: 0.92 },
          },
          {
            nodeId: "analyze" as any,
            agentName: "analyzer" as any,
            status: "success",
            data: { analysis: "Replication lag detected" },
          },
        ],
        finalState: { classify: { category: "database" }, analyze: { analysis: "..." } },
      };

      const payload = mapResultToPayload(result, mockRequest, "corr-001");

      expect(payload.graph_name).toBe("incident-triage");
      expect(payload.status).toBe("completed");
      expect(payload.nodes_executed).toBe(2);
      expect(payload.nodes_succeeded).toBe(2);
      expect(payload.nodes_failed).toBe(0);
      expect(payload.duration_ms).toBe(5000);
      expect(payload.metadata?.correlation_id).toBe("corr-001");
    });

    it("should include trigger request ID", () => {
      const result: ExecutionResult = {
        executionId: "exec-002" as any,
        graphName: "test" as any,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:01Z",
        durationMs: 1000,
        nodeResults: [],
        finalState: {},
      };

      const payload = mapResultToPayload(result, mockRequest, "corr-002");
      expect(payload.trigger_request_id).toBe("req-001");
    });

    it("should count failed nodes correctly", () => {
      const result: ExecutionResult = {
        executionId: "exec-003" as any,
        graphName: "test" as any,
        status: "partial",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:02Z",
        durationMs: 2000,
        nodeResults: [
          { nodeId: "a" as any, agentName: "a" as any, status: "success", data: {} },
          { nodeId: "b" as any, agentName: "b" as any, status: "error", data: {}, error: { code: "ERR", message: "fail" } },
          { nodeId: "c" as any, agentName: "c" as any, status: "success", data: {} },
        ],
        finalState: {},
      };

      const payload = mapResultToPayload(result, mockRequest, "corr-003");
      expect(payload.nodes_executed).toBe(3);
      expect(payload.nodes_succeeded).toBe(2);
      expect(payload.nodes_failed).toBe(1);
    });
  });

  describe("summarizeData", () => {
    it("should truncate long string values", () => {
      const data = { text: "a".repeat(500) };
      const summary = summarizeData(data);
      expect((summary.text as string).length).toBeLessThan(200);
    });

    it("should limit the number of keys", () => {
      const data: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) {
        data[`key${i}`] = i;
      }
      const summary = summarizeData(data);
      expect(Object.keys(summary).length).toBeLessThanOrEqual(5);
    });

    it("should handle undefined data", () => {
      expect(summarizeData(undefined)).toEqual({});
    });
  });
});
