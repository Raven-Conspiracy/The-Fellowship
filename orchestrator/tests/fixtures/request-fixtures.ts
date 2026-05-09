/**
 * Request Fixtures
 *
 * Factory functions for creating test `ExecutionRequest` objects.
 * Used in integration tests and GraphRunner tests to simulate
 * AIP Logic triggering a graph execution.
 */

import { ulid } from "ulid";
import type {
  ExecutionRequest,
  GraphName,
  ExecutionId,
  RequestId,
} from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

export const DEFAULT_GRAPH_NAME = "test-graph" as GraphName;
export const DEFAULT_REQUEST_ID_PREFIX = "01JREQ";

// ---------------------------------------------------------------------------
// ExecutionRequest factory
// ---------------------------------------------------------------------------

/**
 * Create a complete `ExecutionRequest` for testing.
 *
 * @param overrides - Partial overrides for any request field
 * @returns A fully-formed ExecutionRequest
 */
export function createExecutionRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  const requestId = (overrides.requestId ?? `${DEFAULT_REQUEST_ID_PREFIX}${ulid()}`) as RequestId;

  return {
    requestId,
    graphName: overrides.graphName ?? DEFAULT_GRAPH_NAME,
    input: overrides.input ?? {
      incident_id: "test-incident-001",
      raw_text: "Test incident for integration testing",
      source: "test-fixture",
    },
    metadata: overrides.metadata ?? {
      triggeredBy: "test-suite",
      triggerSource: "manual",
      correlationId: ulid(),
      startedAt: new Date().toISOString(),
    },
    options: overrides.options ?? {
      timeoutMs: 30_000,
      persistCheckpoints: false,
      enableStreamEvents: false,
    },
  };
}

/**
 * Create an `ExecutionRequest` for a specific named graph.
 *
 * @param graphName - The graph to execute
 * @param input     - Optional input payload overrides
 */
export function createRequestForGraph(
  graphName: GraphName,
  input?: Record<string, unknown>,
): ExecutionRequest {
  return createExecutionRequest({
    graphName,
    input: input ?? { test_key: "test_value" },
  });
}

// ---------------------------------------------------------------------------
// Specialized request factories
// ---------------------------------------------------------------------------

/**
 * Create a request for the incident-triage graph.
 */
export function createTriageRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return createExecutionRequest({
    graphName: "incident-triage" as GraphName,
    input: {
      incident_id: `incident-${ulid()}`,
      raw_text: "Database replication lag on us-east-1 — alerts firing",
      severity: "high",
      ...overrides.input,
    },
    ...overrides,
  });
}

/**
 * Create a request for the data-enrichment graph.
 */
export function createEnrichmentRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return createExecutionRequest({
    graphName: "data-enrichment" as GraphName,
    input: {
      source_ids: ["src-001", "src-002"],
      query_params: { date_from: "2026-01-01", date_to: "2026-01-31" },
      ...overrides.input,
    },
    ...overrides,
  });
}

/**
 * Create a minimal request for fast unit tests.
 */
export function createMinimalRequest(): ExecutionRequest {
  return {
    requestId: `minimal-${ulid()}` as RequestId,
    graphName: "minimal" as GraphName,
    input: {},
    metadata: {
      triggeredBy: "test",
      triggerSource: "manual",
      correlationId: ulid(),
      startedAt: new Date().toISOString(),
    },
    options: {},
  };
}
