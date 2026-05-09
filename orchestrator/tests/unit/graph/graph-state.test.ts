/**
 * Graph State — Unit Tests
 *
 * Tests for `GraphState` immutability: set() returns a new state,
 * get/snapshot semantics, and key tracking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ulid } from "ulid";

// Minimal GraphState implementation mirroring what Builder Agent 1 will create.
// In production, import from ../../src/graph/graph-state.js

type GraphId = string & { readonly __brand: "GraphId" };
type ExecutionId = string & { readonly __brand: "ExecutionId" };

interface GraphStateSnapshot {
  graphId: GraphId;
  executionId: ExecutionId;
  [key: string]: unknown;
}

class GraphState {
  private readonly _data: Map<string, unknown>;
  public readonly graphId: GraphId;
  public readonly executionId: ExecutionId;

  constructor(graphId: GraphId, executionId: ExecutionId, initialData?: Record<string, unknown>) {
    this.graphId = graphId;
    this.executionId = executionId;
    this._data = new Map(Object.entries(initialData ?? {}));
  }

  set(key: string, value: unknown): GraphState {
    const newState = new GraphState(this.graphId, this.executionId);
    // Copy existing data
    for (const [k, v] of this._data) {
      newState._data.set(k, v);
    }
    newState._data.set(key, value);
    return newState;
  }

  setMultiple(entries: Record<string, unknown>): GraphState {
    let current: GraphState = this;
    for (const [key, value] of Object.entries(entries)) {
      current = current.set(key, value);
    }
    return current;
  }

  get<T = unknown>(key: string): T | undefined {
    return this._data.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this._data.has(key);
  }

  keys(): string[] {
    return Array.from(this._data.keys());
  }

  snapshot(): GraphStateSnapshot {
    const snap: GraphStateSnapshot = {
      graphId: this.graphId,
      executionId: this.executionId,
    };
    for (const [key, value] of this._data) {
      snap[key] = value;
    }
    return snap;
  }

  clone(): GraphState {
    const cloned = new GraphState(this.graphId, this.executionId);
    for (const [k, v] of this._data) {
      cloned._data.set(k, v);
    }
    return cloned;
  }

  get size(): number {
    return this._data.size;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TEST_GRAPH_ID = "test-graph" as GraphId;
const TEST_EXECUTION_ID = ulid() as ExecutionId;

describe("GraphState", () => {
  let state: GraphState;

  beforeEach(() => {
    state = new GraphState(TEST_GRAPH_ID, TEST_EXECUTION_ID);
  });

  describe("construction", () => {
    it("should create an empty state with graphId and executionId", () => {
      expect(state.graphId).toBe(TEST_GRAPH_ID);
      expect(state.executionId).toBe(TEST_EXECUTION_ID);
      expect(state.size).toBe(0);
    });

    it("should accept initial data", () => {
      const s = new GraphState(TEST_GRAPH_ID, TEST_EXECUTION_ID, {
        key1: "value1",
        key2: 42,
      });
      expect(s.size).toBe(2);
      expect(s.get("key1")).toBe("value1");
      expect(s.get("key2")).toBe(42);
    });
  });

  describe("immutability — set() returns new state", () => {
    it("should return a new instance on set()", () => {
      const newState = state.set("a", 1);
      expect(newState).not.toBe(state);
      expect(newState).toBeInstanceOf(GraphState);
    });

    it("should not mutate the original state", () => {
      state.set("a", 1);
      expect(state.has("a")).toBe(false);
      expect(state.size).toBe(0);
    });

    it("should carry forward existing keys", () => {
      const s1 = state.set("a", 1);
      const s2 = s1.set("b", 2);

      expect(s2.get("a")).toBe(1);
      expect(s2.get("b")).toBe(2);
      expect(s2.size).toBe(2);
      expect(s1.size).toBe(1); // s1 unchanged
    });

    it("should allow overwriting a key", () => {
      const s1 = state.set("a", 1);
      const s2 = s1.set("a", 99);

      expect(s1.get("a")).toBe(1);
      expect(s2.get("a")).toBe(99);
    });
  });

  describe("setMultiple", () => {
    it("should set multiple keys at once", () => {
      const s1 = state.setMultiple({ a: 1, b: 2, c: 3 });
      expect(s1.size).toBe(3);
      expect(s1.get("a")).toBe(1);
      expect(s1.get("b")).toBe(2);
      expect(s1.get("c")).toBe(3);
    });
  });

  describe("get", () => {
    it("should return undefined for missing keys", () => {
      expect(state.get("nonexistent")).toBeUndefined();
    });

    it("should retrieve typed values", () => {
      const s = state.set("confidence", 0.95).set("category", "database");
      expect(s.get<number>("confidence")).toBe(0.95);
      expect(s.get<string>("category")).toBe("database");
    });

    it("should retrieve complex objects", () => {
      const obj = { nested: { deep: true } };
      const s = state.set("complex", obj);
      expect(s.get("complex")).toEqual(obj);
    });
  });

  describe("has", () => {
    it("should return true for set keys", () => {
      const s = state.set("key", "value");
      expect(s.has("key")).toBe(true);
    });

    it("should return false for missing keys", () => {
      expect(state.has("missing")).toBe(false);
    });
  });

  describe("keys", () => {
    it("should return all keys", () => {
      const s = state.setMultiple({ a: 1, b: 2, c: 3 });
      expect(s.keys()).toEqual(expect.arrayContaining(["a", "b", "c"]));
    });
  });

  describe("snapshot", () => {
    it("should return a plain object with graphId and executionId", () => {
      const s = state.set("result", "done").set("confidence", 0.9);
      const snap = s.snapshot();

      expect(snap.graphId).toBe(TEST_GRAPH_ID);
      expect(snap.executionId).toBe(TEST_EXECUTION_ID);
      expect(snap.result).toBe("done");
      expect(snap.confidence).toBe(0.9);
    });

    it("should be a shallow copy (JSON safe)", () => {
      const s = state.set("data", { key: "value" });
      const snap = s.snapshot();

      // Modifying the snapshot should not affect the state
      (snap as any).data = "modified";
      expect(s.get("data")).toEqual({ key: "value" });
    });
  });

  describe("clone", () => {
    it("should create an independent copy", () => {
      const s1 = state.set("a", 1).set("b", 2);
      const cloned = s1.clone();

      expect(cloned.get("a")).toBe(1);
      expect(cloned.get("b")).toBe(2);

      // Modifying clone does not affect original
      const s2 = cloned.set("c", 3);
      expect(s1.has("c")).toBe(false);
      expect(s2.has("c")).toBe(true);
    });
  });

  describe("thread safety (simulated)", () => {
    it("should be safe to chain multiple sets from the same base", () => {
      const base = state.set("shared", 0);

      const branch1 = base.set("b1", 1);
      const branch2 = base.set("b2", 2);

      // Both branches started from the same base
      expect(branch1.get("shared")).toBe(0);
      expect(branch2.get("shared")).toBe(0);

      // Each branch is independent
      expect(branch1.get("b1")).toBe(1);
      expect(branch1.has("b2")).toBe(false);
      expect(branch2.get("b2")).toBe(2);
      expect(branch2.has("b1")).toBe(false);
    });
  });
});
