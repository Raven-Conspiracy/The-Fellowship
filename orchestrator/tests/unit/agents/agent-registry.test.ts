/**
 * Agent Registry — Unit Tests
 *
 * Tests for registration, lookup, list, has, duplicate detection,
 * and YAML config loading.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockLogger } from "../../mocks/logger.mock.js";
import type { MockLogger } from "../../mocks/logger.mock.js";
import { createAgentEndpointConfig, createAgentEndpointConfigs } from "../../fixtures/agent-fixtures.js";
import type { AgentEndpointConfig, AgentName } from "../../../src/core/types.js";
import { AgentRegistry } from "../../../src/agents/agent-registry.js";

describe("AgentRegistry", () => {
  let registry: AgentRegistry;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    registry = new AgentRegistry(logger);
  });

  describe("register", () => {
    it("should register a single agent", () => {
      const config = createAgentEndpointConfig({ name: "test-agent" as AgentName });
      const result = registry.register(config);

      expect(result.isOk()).toBe(true);
      expect(registry.has("test-agent" as AgentName)).toBe(true);
    });

    it("should accept agents with case-insensitive names", () => {
      const config = createAgentEndpointConfig({ name: "TestAgent" as AgentName });
      registry.register(config);

      expect(registry.has("testagent" as AgentName)).toBe(true);
      expect(registry.has("TESTAGENT" as AgentName)).toBe(true);
      expect(registry.has("TestAgent" as AgentName)).toBe(true);
    });

    it("should reject duplicate registration", () => {
      const config = createAgentEndpointConfig({ name: "dup" as AgentName });
      registry.register(config);
      const result = registry.register(config);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("AGENT_REGISTRY_ERROR");
      }
    });

    it("should allow overwrite when flag is set", () => {
      const original = createAgentEndpointConfig({ name: "agent" as AgentName, route: "/old" });
      const updated = createAgentEndpointConfig({ name: "agent" as AgentName, route: "/new" });

      registry.register(original);
      const result = registry.register(updated, true);

      expect(result.isOk()).toBe(true);
      const retrieved = registry.get("agent" as AgentName);
      expect(retrieved.isOk() && retrieved.value.route).toBe("/new");
    });
  });

  describe("registerAll", () => {
    it("should register multiple agents at once", () => {
      const configs = createAgentEndpointConfigs(["a", "b", "c"]);
      const result = registry.registerAll(configs);

      expect(result.isOk()).toBe(true);
      expect(registry.size).toBe(3);
    });

    it("should fail on first duplicate", () => {
      const configs = createAgentEndpointConfigs(["a", "b", "a"]);
      const result = registry.registerAll(configs);

      expect(result.isErr()).toBe(true);
      // Only 2 should be registered (a, b)
      expect(registry.size).toBe(2);
    });
  });

  describe("get", () => {
    it("should return the endpoint config for a registered agent", () => {
      const config = createAgentEndpointConfig({ name: "finder" as AgentName, route: "/find" });
      registry.register(config);

      const result = registry.get("finder" as AgentName);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.route).toBe("/find");
      }
    });

    it("should return error for unregistered agent", () => {
      const result = registry.get("missing" as AgentName);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe("AGENT_REGISTRY_ERROR");
      }
    });
  });

  describe("has", () => {
    it("should return true for registered agents", () => {
      registry.register(createAgentEndpointConfig({ name: "exists" as AgentName }));
      expect(registry.has("exists" as AgentName)).toBe(true);
    });

    it("should return false for unregistered agents", () => {
      expect(registry.has("ghost" as AgentName)).toBe(false);
    });
  });

  describe("list", () => {
    it("should return all agent names sorted", () => {
      registry.registerAll(createAgentEndpointConfigs(["c", "a", "b"]));
      expect(registry.list()).toEqual(["a", "b", "c"]);
    });

    it("should return empty array when no agents registered", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("remove", () => {
    it("should remove a registered agent", () => {
      registry.register(createAgentEndpointConfig({ name: "removable" as AgentName }));
      expect(registry.has("removable" as AgentName)).toBe(true);

      const result = registry.remove("removable" as AgentName);
      expect(result).toBe(true);
      expect(registry.has("removable" as AgentName)).toBe(false);
    });

    it("should return false when agent not found", () => {
      expect(registry.remove("nope" as AgentName)).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all agents", () => {
      registry.registerAll(createAgentEndpointConfigs(["a", "b", "c"]));
      expect(registry.size).toBe(3);

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.list()).toEqual([]);
    });
  });

  describe("size", () => {
    it("should report the correct count", () => {
      expect(registry.size).toBe(0);
      registry.register(createAgentEndpointConfig({ name: "one" as AgentName }));
      expect(registry.size).toBe(1);
    });
  });
});
