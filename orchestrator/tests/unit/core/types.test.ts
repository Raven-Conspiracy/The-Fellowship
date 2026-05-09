/**
 * Core Types — Unit Tests
 *
 * Tests for branded types, type narrowing, and type utilities.
 * Since branded types are compile-time constructs, these tests
 * primarily validate the runtime behavior of type factories and
 * guards.
 */

import { describe, it, expect } from "vitest";
import { ulid } from "ulid";

// Branded types from core/types are expected to be defined by Builder Agent 1.
// We test the concept using our own branded type declarations for now.
// In production, these imports would come from core/types.ts.

type AgentName = string & { readonly __brand: "AgentName" };
type GraphId = string & { readonly __brand: "GraphId" };
type ExecutionId = string & { readonly __brand: "ExecutionId" };
type NodeId = string & { readonly __brand: "NodeId" };
type RequestId = string & { readonly __brand: "RequestId" };

// ---------------------------------------------------------------------------
// Brand factories (mirroring what Builder Agent 1 will create)
// ---------------------------------------------------------------------------

function asAgentName(value: string): AgentName {
  return value as AgentName;
}

function asGraphId(value: string): GraphId {
  return value as GraphId;
}

function asExecutionId(value: string): ExecutionId {
  return value as ExecutionId;
}

function createExecutionId(): ExecutionId {
  return ulid() as ExecutionId;
}

function createGraphId(): GraphId {
  return ulid() as GraphId;
}

function createRequestId(): RequestId {
  return ulid() as RequestId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Branded Types", () => {
  describe("AgentName", () => {
    it("should create a branded AgentName from a string", () => {
      const name = asAgentName("classifier");
      expect(name).toBe("classifier");
      expect(typeof name).toBe("string");
    });

    it("should support string operations on branded type", () => {
      const name = asAgentName("ANALYZER");
      expect(name.toLowerCase()).toBe("analyzer");
      expect(name.length).toBe(8);
    });

    it("should be usable as object keys", () => {
      const map = new Map<AgentName, string>();
      map.set(asAgentName("classifier"), "/striveworks/classify");
      expect(map.get(asAgentName("classifier"))).toBe("/striveworks/classify");
    });
  });

  describe("GraphId", () => {
    it("should generate a ULID-based GraphId", () => {
      const id = createGraphId();
      expect(id).toBeTypeOf("string");
      expect(id.length).toBeGreaterThanOrEqual(26); // ULID = 26 chars
    });

    it("should generate unique GraphIds", () => {
      const ids = new Set(Array.from({ length: 100 }, () => createGraphId()));
      expect(ids.size).toBe(100);
    });
  });

  describe("ExecutionId", () => {
    it("should generate a ULID-based ExecutionId", () => {
      const id = createExecutionId();
      expect(id).toBeTypeOf("string");
      expect(id.length).toBeGreaterThanOrEqual(26);
    });

    it("should generate unique ExecutionIds", () => {
      const id1 = createExecutionId();
      const id2 = createExecutionId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("RequestId", () => {
    it("should generate a ULID-based RequestId", () => {
      const id = createRequestId();
      expect(id).toBeTypeOf("string");
      expect(id.length).toBeGreaterThanOrEqual(26);
    });
  });

  describe("Branded Type Safety (runtime behavior)", () => {
    it("should allow comparing branded strings with same brand", () => {
      const a = asGraphId("test-graph");
      const b = asGraphId("test-graph");
      expect(a === b).toBe(true);
    });

    it("should allow storing branded types in collections", () => {
      const executions = new Set<ExecutionId>();
      executions.add(createExecutionId());
      executions.add(createExecutionId());
      expect(executions.size).toBe(2);
    });

    it("should pass branded types through JSON serialization (brands erased)", () => {
      const id = asExecutionId("01JABC123");
      const json = JSON.stringify({ id });
      const parsed = JSON.parse(json);
      // Brand is lost in JSON, but the string value is preserved
      expect(parsed.id).toBe("01JABC123");
    });
  });
});

describe("Type Narrowing Helpers", () => {
  describe("isDefined (type guard)", () => {
    function isDefined<T>(value: T | undefined | null): value is T {
      return value !== undefined && value !== null;
    }

    it("should return true for defined values", () => {
      expect(isDefined("hello")).toBe(true);
      expect(isDefined(0)).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined({})).toBe(true);
    });

    it("should return false for undefined and null", () => {
      expect(isDefined(undefined)).toBe(false);
      expect(isDefined(null)).toBe(false);
    });

    it("should filter arrays correctly", () => {
      const arr = ["a", undefined, "b", null, "c"];
      const filtered = arr.filter(isDefined);
      expect(filtered).toEqual(["a", "b", "c"]);
    });
  });

  describe("hasProperty (type guard)", () => {
    function hasProperty<K extends string>(
      obj: unknown,
      key: K,
    ): obj is Record<K, unknown> {
      return typeof obj === "object" && obj !== null && key in obj;
    }

    it("should detect existing properties", () => {
      const obj = { name: "test", value: 42 };
      expect(hasProperty(obj, "name")).toBe(true);
      expect(hasProperty(obj, "value")).toBe(true);
    });

    it("should reject missing properties", () => {
      const obj = { name: "test" };
      expect(hasProperty(obj, "value")).toBe(false);
    });

    it("should handle null and non-objects", () => {
      expect(hasProperty(null, "key")).toBe(false);
      expect(hasProperty(undefined, "key")).toBe(false);
      expect(hasProperty("string", "length")).toBe(false); // primitive
    });
  });
});
