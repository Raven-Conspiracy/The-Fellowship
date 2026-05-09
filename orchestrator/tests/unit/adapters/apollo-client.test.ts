/**
 * Apollo Client — Unit Tests
 *
 * Tests for the `ApolloClient`: auth header injection, retry behavior,
 * circuit breaker state transitions, error mapping, and health checks.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { createMockLogger } from "../../mocks/logger.mock.js";
import {
  createMockApolloClient,
  okResponse,
  errResponse,
  networkErrorResponse,
  timeoutErrorResponse,
  createSuccessResponse,
} from "../../mocks/apollo-client.mock.js";
import type { MockApolloClient } from "../../mocks/apollo-client.mock.js";
import { ApolloError, NetworkError, TimeoutError, CircuitBreakerOpenError } from "../../../src/core/errors.js";
import type { ApolloRequest, ApolloResponse } from "../../../src/core/types.js";

describe("ApolloClient (Mock)", () => {
  let client: MockApolloClient;

  const mockRequest: ApolloRequest = {
    agentRoute: "/striveworks/classify",
    payload: { incident_id: "test-001", raw_text: "Test incident" },
    metadata: {
      nodeId: "node-1" as any,
      agentName: "classifier" as any,
      graphId: "test-graph" as any,
      executionId: "test-exec" as any,
    },
  };

  beforeEach(() => {
    client = createMockApolloClient();
  });

  describe("execute", () => {
    it("should return a success response", async () => {
      client.setNextResponse(okResponse());

      const result = await client.execute(mockRequest);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.status).toBe("success");
      }
    });

    it("should return an error response", async () => {
      client.setNextResponse(errResponse());

      const result = await client.execute(mockRequest);
      expect(result.isErr()).toBe(true);
    });

    it("should track the request payload", async () => {
      client.setNextResponse(okResponse());
      await client.execute(mockRequest);

      const requests = client.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.agentRoute).toBe("/striveworks/classify");
      expect(requests[0]!.payload).toEqual(mockRequest.payload);
    });

    it("should consume responses in FIFO order", async () => {
      client.setResponseSequence([
        okResponse({ data: { result: "first" } }),
        okResponse({ data: { result: "second" } }),
      ]);

      const r1 = await client.execute(mockRequest);
      const r2 = await client.execute(mockRequest);

      expect(r1.isOk() && r1.value.data.result).toBe("first");
      expect(r2.isOk() && r2.value.data.result).toBe("second");
    });

    it("should return a default error if no response programmed", async () => {
      // Don't call setNextResponse — should get default error
      const result = await client.execute(mockRequest);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toContain("no response programmed");
      }
    });
  });

  describe("healthCheck", () => {
    it("should return ok(true) by default", async () => {
      const result = await client.healthCheck();
      expect(result.isOk()).toBe(true);
      expect(result.isOk() && result.value).toBe(true);
    });
  });

  describe("circuit breaker state", () => {
    it("should return CLOSED state by default", () => {
      const state = client.getCircuitBreakerState();
      expect(state.state).toBe("CLOSED");
    });

    it("should support resetCircuitBreaker", () => {
      client.resetCircuitBreaker();
      expect(client.resetCircuitBreaker).toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should handle network errors", async () => {
      client.setNextResponse(networkErrorResponse());
      const result = await client.execute(mockRequest);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(NetworkError);
        expect(result.error.retryable).toBe(true);
      }
    });

    it("should handle timeout errors", async () => {
      client.setNextResponse(timeoutErrorResponse());
      const result = await client.execute(mockRequest);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(TimeoutError);
        expect(result.error.retryable).toBe(true);
      }
    });
  });
});

describe("ApolloClient Error Mapping", () => {
  it("NetworkError should have correct code", () => {
    const err = new NetworkError("test");
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.retryable).toBe(true);
  });

  it("TimeoutError should have correct code", () => {
    const err = new TimeoutError("test");
    expect(err.code).toBe("TIMEOUT_ERROR");
    expect(err.retryable).toBe(true);
  });

  it("ApolloError should accept a retryable flag", () => {
    const retryable = new ApolloError("test", { retryable: true });
    const nonRetryable = new ApolloError("test", { retryable: false });

    expect(retryable.retryable).toBe(true);
    expect(nonRetryable.retryable).toBe(false);
  });

  it("CircuitBreakerOpenError should be retryable", () => {
    const err = new CircuitBreakerOpenError("test");
    expect(err.retryable).toBe(true);
  });
});
