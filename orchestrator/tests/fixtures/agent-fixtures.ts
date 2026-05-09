/**
 * Agent Fixtures
 *
 * Factory functions for creating test `AgentNodeConfig`, `AgentEndpointConfig`,
 * and `AgentResult` objects. These are used across unit and integration tests
 * to avoid duplicating test data setup.
 */

import type {
  AgentName,
  AgentNodeId,
  AgentNodeConfig,
  AgentEndpointConfig,
  AgentResult,
  RetryPolicy,
  Condition,
} from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_NAME = "test-agent" as AgentName;
export const DEFAULT_AGENT_ROUTE = "/striveworks/test-agent";
export const DEFAULT_NODE_ID = "test-node" as AgentNodeId;

// ---------------------------------------------------------------------------
// AgentEndpointConfig factories
// ---------------------------------------------------------------------------

/**
 * Create a minimal `AgentEndpointConfig` for testing.
 */
export function createAgentEndpointConfig(
  overrides: Partial<AgentEndpointConfig> = {},
): AgentEndpointConfig {
  return {
    name: (overrides.name ?? DEFAULT_AGENT_NAME) as AgentName,
    route: overrides.route ?? DEFAULT_AGENT_ROUTE,
    timeoutMs: overrides.timeoutMs ?? 10_000,
    maxRetries: overrides.maxRetries ?? 3,
    backoffBaseMs: overrides.backoffBaseMs ?? 500,
    description: overrides.description,
    inputSchema: overrides.inputSchema,
    outputSchema: overrides.outputSchema,
  };
}

/**
 * Create an array of `AgentEndpointConfig` for populating an `AgentRegistry`.
 */
export function createAgentEndpointConfigs(
  names: string[],
): AgentEndpointConfig[] {
  return names.map((name) =>
    createAgentEndpointConfig({
      name: name as AgentName,
      route: `/striveworks/${name}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// AgentNodeConfig factories
// ---------------------------------------------------------------------------

/**
 * Create a minimal `AgentNodeConfig` for testing.
 */
export function createAgentNodeConfig(
  overrides: Partial<AgentNodeConfig> = {},
): AgentNodeConfig {
  return {
    id: (overrides.id ?? DEFAULT_NODE_ID) as AgentNodeId,
    agentName: (overrides.agentName ?? DEFAULT_AGENT_NAME) as AgentName,
    dependsOn: overrides.dependsOn ?? [],
    inputMapping: overrides.inputMapping,
    condition: overrides.condition,
    retryPolicy: overrides.retryPolicy,
    timeoutMs: overrides.timeoutMs,
    description: overrides.description,
  };
}

/**
 * Create multiple `AgentNodeConfig` objects from a list of names.
 */
export function createAgentNodeConfigs(
  names: string[],
): AgentNodeConfig[] {
  return names.map((name, index) =>
    createAgentNodeConfig({
      id: `node-${index + 1}` as AgentNodeId,
      agentName: name as AgentName,
      dependsOn: index > 0 ? [`node-${index}`] : [],
    }),
  );
}

// ---------------------------------------------------------------------------
// RetryPolicy factories
// ---------------------------------------------------------------------------

/**
 * Create a `RetryPolicy` with sensible test defaults.
 */
export function createRetryPolicy(
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return {
    maxAttempts: overrides.maxAttempts ?? 3,
    backoffBaseMs: overrides.backoffBaseMs ?? 100,
    maxBackoffMs: overrides.maxBackoffMs ?? 500,
  };
}

// ---------------------------------------------------------------------------
// Condition factories
// ---------------------------------------------------------------------------

/**
 * Create a `Condition` for testing conditional nodes.
 */
export function createCondition(expression?: string): Condition {
  return {
    type: "predicate",
    expression: expression ?? "state.someKey === true",
  };
}

// ---------------------------------------------------------------------------
// AgentResult factories
// ---------------------------------------------------------------------------

/**
 * Create a successful `AgentResult` for testing.
 */
export function createSuccessResult(
  overrides: Partial<AgentResult> = {},
): AgentResult {
  return {
    nodeId: (overrides.nodeId ?? DEFAULT_NODE_ID) as AgentNodeId,
    agentName: (overrides.agentName ?? DEFAULT_AGENT_NAME) as AgentName,
    status: "success",
    data: overrides.data ?? { result: "test-output", confidence: 0.95 },
    metadata: overrides.metadata ?? {
      durationMs: 150,
      attempts: 1,
    },
    error: undefined,
  };
}

/**
 * Create a failed `AgentResult` for testing.
 */
export function createErrorResult(
  overrides: Partial<AgentResult> = {},
): AgentResult {
  return {
    nodeId: (overrides.nodeId ?? DEFAULT_NODE_ID) as AgentNodeId,
    agentName: (overrides.agentName ?? DEFAULT_AGENT_NAME) as AgentName,
    status: "error",
    data: overrides.data ?? {},
    metadata: overrides.metadata ?? {
      durationMs: 250,
      attempts: 3,
    },
    error: overrides.error ?? {
      code: "TEST_ERROR",
      message: "Simulated agent failure for testing",
    },
  };
}

// ---------------------------------------------------------------------------
// Named agent lists
// ---------------------------------------------------------------------------

/** Standard agents used in the incident-triage graph. */
export const TRIAGE_AGENTS = ["classifier", "analyzer", "summarizer", "escalator"] as const;

/** Standard agents used in the data-enrichment graph. */
export const ENRICHMENT_AGENTS = ["fetcher", "normalizer", "merger", "validator"] as const;

/** All known agent names for comprehensive tests. */
export const ALL_TEST_AGENTS = [
  ...TRIAGE_AGENTS,
  ...ENRICHMENT_AGENTS,
  "gatherer",
  "formatter",
  "deliverer",
] as const;
