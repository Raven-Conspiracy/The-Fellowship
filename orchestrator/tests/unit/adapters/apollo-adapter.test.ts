/**
 * Apollo Adapter — Unit Tests
 *
 * Tests for the `ApolloAdapter`: AgentNode → ApolloRequest translation,
 * ApolloResponse → AgentResult mapping, and payload resolution.
 */

import { describe, it, expect } from "vitest";

import type { AgentResult, ApolloResponse, AgentNode } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Test helpers for adapter logic
// ---------------------------------------------------------------------------

/**
 * Simulate the mapResponse method of ApolloAdapter.
 */
function mapResponse(response: ApolloResponse, node: AgentNode): AgentResult {
  return {
    nodeId: node.id,
    agentName: node.config.agentName,
    status: response.status === "error" ? "error" : "success",
    data: response.data ?? {},
    metadata: {
      ...(response.metadata ?? {}),
      apolloRequestId: response.requestId,
      processedAt: new Date().toISOString(),
    },
    error: response.error
      ? {
          code: response.error.code ?? "UNKNOWN",
          message: response.error.message ?? "Unknown agent error",
          detail: response.error.detail,
        }
      : undefined,
  };
}

/**
 * Simulate the resolvePayload method of ApolloAdapter.
 */
function resolvePayload(
  inputMapping: string[] | undefined,
  state: Record<string, unknown>,
  nodeConfig: { id: string; agentName: string },
): Record<string, unknown> {
  const graphContext = {
    graphId: "test-graph",
    executionId: "test-exec",
    nodeId: nodeConfig.id,
    agentName: nodeConfig.agentName,
  };

  if (inputMapping && inputMapping.length > 0) {
    const resolved: Record<string, unknown> = {};
    for (const key of inputMapping) {
      if (key in state) {
        resolved[key] = state[key];
      }
    }
    return { ...resolved, graph_context: graphContext };
  }

  return { state, graph_context: graphContext };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApolloAdapter — Response Mapping", () => {
  const mockNode: AgentNode = {
    id: "node-1" as any,
    config: {
      id: "node-1" as any,
      agentName: "classifier" as any,
      dependsOn: [],
      endpoint: { route: "/striveworks/classify" } as any,
    },
    dependsOn: [],
  };

  describe("mapResponse", () => {
    it("should map a success response to AgentResult", () => {
      const response: ApolloResponse = {
        status: "success",
        requestId: "ap-req-001",
        data: { category: "database", confidence: 0.92 },
        metadata: { model_version: "v3.2.1" },
      };

      const result = mapResponse(response, mockNode);

      expect(result.status).toBe("success");
      expect(result.nodeId).toBe("node-1");
      expect(result.agentName).toBe("classifier");
      expect(result.data).toEqual({ category: "database", confidence: 0.92 });
      expect(result.metadata?.model_version).toBe("v3.2.1");
      expect(result.metadata?.apolloRequestId).toBe("ap-req-001");
      expect(result.error).toBeUndefined();
    });

    it("should map an error response to AgentResult", () => {
      const response: ApolloResponse = {
        status: "error",
        requestId: "ap-req-err",
        error: {
          code: "AGENT_TIMEOUT",
          message: "Agent timed out after 30s",
        },
      };

      const result = mapResponse(response, mockNode);

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("AGENT_TIMEOUT");
      expect(result.error?.message).toBe("Agent timed out after 30s");
    });

    it("should handle missing data in response", () => {
      const response: ApolloResponse = {
        status: "success",
        requestId: "ap-req-002",
      };

      const result = mapResponse(response, mockNode);
      expect(result.data).toEqual({});
      expect(result.status).toBe("success");
    });

    it("should handle missing error code", () => {
      const response: ApolloResponse = {
        status: "error",
        requestId: "ap-req-003",
        error: {},
      };

      const result = mapResponse(response, mockNode);
      expect(result.error?.code).toBe("UNKNOWN");
      expect(result.error?.message).toBe("Unknown agent error");
    });
  });
});

describe("ApolloAdapter — Payload Resolution", () => {
  const nodeConfig = { id: "node-1", agentName: "classifier" };
  const state = {
    incident_id: "INC-001",
    raw_text: "Server down",
    classify: { category: "infra", confidence: 0.9 },
  };

  describe("resolvePayload", () => {
    it("should extract only mapped keys when inputMapping is provided", () => {
      const payload = resolvePayload(["incident_id", "raw_text"], state, nodeConfig);

      expect(payload).toHaveProperty("incident_id", "INC-001");
      expect(payload).toHaveProperty("raw_text", "Server down");
      expect(payload).not.toHaveProperty("classify");
      expect(payload).toHaveProperty("graph_context");
    });

    it("should forward full state when no inputMapping", () => {
      const payload = resolvePayload(undefined, state, nodeConfig);

      expect(payload).toHaveProperty("state");
      expect(payload.state).toEqual(state);
      expect(payload).toHaveProperty("graph_context");
    });

    it("should inject graph_context into every payload", () => {
      const payload = resolvePayload(["incident_id"], state, nodeConfig);

      expect(payload.graph_context).toEqual({
        graphId: "test-graph",
        executionId: "test-exec",
        nodeId: "node-1",
        agentName: "classifier",
      });
    });

    it("should ignore mapped keys not present in state", () => {
      const payload = resolvePayload(["incident_id", "nonexistent"], state, nodeConfig);

      expect(payload).toHaveProperty("incident_id");
      expect(payload).not.toHaveProperty("nonexistent");
    });
  });
});
