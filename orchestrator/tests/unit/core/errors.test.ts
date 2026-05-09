/**
 * Core Errors — Unit Tests
 *
 * Tests for the DomainError hierarchy: construction, serialization,
 * retryable flags, toJSON, and error code discrimination.
 */

import { describe, it, expect } from "vitest";

// Mock DomainError hierarchy (mirrors what Builder Agent 1 will create in core/errors.ts)
// In production, these would be imported from ../../src/core/errors.js

class DomainError extends Error {
  public readonly code: string;
  public readonly retryable?: boolean;
  public readonly detail?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(message: string, opts: {
    code?: string;
    retryable?: boolean;
    detail?: Record<string, unknown>;
    cause?: Error;
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = opts.code ?? "DOMAIN_ERROR";
    this.retryable = opts.retryable;
    this.detail = opts.detail;
    this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      detail: this.detail,
      stack: this.stack?.split("\n").slice(0, 5),
    };
  }
}

class NetworkError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "NETWORK_ERROR", retryable: true });
  }
}

class TimeoutError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "TIMEOUT_ERROR", retryable: true });
  }
}

class AuthenticationError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "AUTHENTICATION_ERROR", retryable: false });
  }
}

class ApolloError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "APOLLO_ERROR" });
    this.retryable = opts.retryable as boolean | undefined;
  }
}

class ApolloAdapterError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "APOLLO_ADAPTER_ERROR", retryable: false });
  }
}

class CircuitBreakerOpenError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "CIRCUIT_BREAKER_OPEN", retryable: true });
  }
}

class AgentRegistryError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "AGENT_REGISTRY_ERROR", retryable: false });
  }
}

class AgentExecutionError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "AGENT_EXECUTION_ERROR", retryable: false });
  }
}

class GraphValidationError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "GRAPH_VALIDATION_ERROR", retryable: false });
  }
}

class GraphCycleError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "GRAPH_CYCLE_ERROR", retryable: false });
  }
}

class FoundryWriteError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "FOUNDRY_WRITE_ERROR", retryable: false });
  }
}

class FoundryAuthError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "FOUNDRY_AUTH_ERROR", retryable: false });
  }
}

class FoundryStreamError extends DomainError {
  constructor(message: string, opts: Record<string, unknown> = {}) {
    super(message, { ...opts, code: "FOUNDRY_STREAM_ERROR", retryable: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DomainError", () => {
  describe("construction", () => {
    it("should create a base DomainError with default code", () => {
      const error = new DomainError("Something went wrong");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DomainError);
      expect(error.message).toBe("Something went wrong");
      expect(error.code).toBe("DOMAIN_ERROR");
    });

    it("should accept a custom code", () => {
      const error = new DomainError("Custom", { code: "CUSTOM_ERROR" });
      expect(error.code).toBe("CUSTOM_ERROR");
    });

    it("should set the name to the class name", () => {
      const error = new DomainError("test");
      expect(error.name).toBe("DomainError");
    });

    it("should store detail context", () => {
      const detail = { agentRoute: "/test", correlationId: "abc" };
      const error = new DomainError("test", { detail });
      expect(error.detail).toEqual(detail);
    });

    it("should store a cause error", () => {
      const cause = new Error("root cause");
      const error = new DomainError("wrapper", { cause });
      expect(error.cause).toBe(cause);
    });
  });

  describe("retryable flag", () => {
    it("should be undefined by default", () => {
      const error = new DomainError("test");
      expect(error.retryable).toBeUndefined();
    });

    it("should be settable to true", () => {
      const error = new NetworkError("network down");
      expect(error.retryable).toBe(true);
    });

    it("should be settable to false", () => {
      const error = new AuthenticationError("bad token");
      expect(error.retryable).toBe(false);
    });
  });

  describe("toJSON", () => {
    it("should return a structured object", () => {
      const error = new NetworkError("connection refused", {
        agentRoute: "/test",
      });
      const json = error.toJSON();

      expect(json).toHaveProperty("name", "NetworkError");
      expect(json).toHaveProperty("code", "NETWORK_ERROR");
      expect(json).toHaveProperty("message", "connection refused");
      expect(json).toHaveProperty("retryable", true);
      expect(json).toHaveProperty("detail");
      expect(json).toHaveProperty("stack");
    });

    it("should pass through JSON.stringify", () => {
      const error = new TimeoutError("timeout");
      const str = JSON.stringify(error);
      const parsed = JSON.parse(str);

      expect(parsed.code).toBe("TIMEOUT_ERROR");
      expect(parsed.retryable).toBe(true);
    });
  });
});

describe("Error Hierarchy", () => {
  describe("NetworkError", () => {
    it("should be retryable", () => {
      const err = new NetworkError("test");
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("NETWORK_ERROR");
    });
  });

  describe("TimeoutError", () => {
    it("should be retryable", () => {
      const err = new TimeoutError("test");
      expect(err.retryable).toBe(true);
      expect(err.code).toBe("TIMEOUT_ERROR");
    });
  });

  describe("AuthenticationError", () => {
    it("should NOT be retryable", () => {
      const err = new AuthenticationError("test");
      expect(err.retryable).toBe(false);
      expect(err.code).toBe("AUTHENTICATION_ERROR");
    });
  });

  describe("ApolloError", () => {
    it("should allow explicit retryable flag", () => {
      const retryable = new ApolloError("test", { retryable: true });
      expect(retryable.retryable).toBe(true);

      const nonRetryable = new ApolloError("test", { retryable: false });
      expect(nonRetryable.retryable).toBe(false);
    });
  });

  describe("CircuitBreakerOpenError", () => {
    it("should be retryable (circuit may recover)", () => {
      const err = new CircuitBreakerOpenError("test");
      expect(err.retryable).toBe(true);
    });
  });

  describe("AgentRegistryError", () => {
    it("should NOT be retryable", () => {
      const err = new AgentRegistryError("test");
      expect(err.retryable).toBe(false);
    });
  });

  describe("AgentExecutionError", () => {
    it("should NOT be retryable (retries already exhausted)", () => {
      const err = new AgentExecutionError("test");
      expect(err.retryable).toBe(false);
    });
  });

  describe("GraphValidationError", () => {
    it("should NOT be retryable", () => {
      const err = new GraphValidationError("test");
      expect(err.retryable).toBe(false);
    });
  });

  describe("GraphCycleError", () => {
    it("should NOT be retryable", () => {
      const err = new GraphCycleError("test");
      expect(err.retryable).toBe(false);
    });
  });

  describe("Foundry errors", () => {
    it("FoundryWriteError should NOT be retryable", () => {
      const err = new FoundryWriteError("test");
      expect(err.retryable).toBe(false);
    });

    it("FoundryAuthError should NOT be retryable", () => {
      const err = new FoundryAuthError("test");
      expect(err.retryable).toBe(false);
    });

    it("FoundryStreamError should be retryable", () => {
      const err = new FoundryStreamError("test");
      expect(err.retryable).toBe(true);
    });
  });

  describe("instanceof checks", () => {
    it("should correctly check inheritance", () => {
      const netErr = new NetworkError("test");
      expect(netErr instanceof DomainError).toBe(true);
      expect(netErr instanceof NetworkError).toBe(true);
      expect(netErr instanceof ApolloError).toBe(false);
    });

    it("should allow switching on error code", () => {
      function handleError(err: DomainError): string {
        switch (err.code) {
          case "NETWORK_ERROR":
            return "retry";
          case "AUTHENTICATION_ERROR":
            return "fail";
          case "CIRCUIT_BREAKER_OPEN":
            return "wait";
          default:
            return "unknown";
        }
      }

      expect(handleError(new NetworkError("test"))).toBe("retry");
      expect(handleError(new AuthenticationError("test"))).toBe("fail");
      expect(handleError(new CircuitBreakerOpenError("test"))).toBe("wait");
    });
  });
});
