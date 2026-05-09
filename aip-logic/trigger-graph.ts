/**
 * AIP Logic Entry Point — Trigger Graph
 *
 * This is the function that AIP Logic calls to invoke the orchestration
 * layer. It is intentionally **thin**: it builds an `ExecutionRequest`,
 * calls `executeGraph()`, and returns an `ExecutionResult`.
 *
 * All coordination logic lives in the orchestrator. AIP Logic sees only:
 * "Run graph X with input Y, give me result Z."
 *
 * ## Usage from AIP Logic
 *
 * ```typescript
 * // Inside an AIP Logic Function:
 * import { triggerGraph } from "@the-fellowship/aip-logic/trigger-graph.js";
 *
 * const result = await triggerGraph("incident-triage", {
 *   incident_id: input.incidentRid,
 *   raw_text: input.description,
 * });
 *
 * if (result.isErr()) {
 *   throw new Error(`Graph execution failed: ${result.error.message}`);
 * }
 *
 * return result.value.finalState;
 * ```
 *
 * ## Return Type
 *
 * This function returns an `AsyncDomainResult<ExecutionResult>` — a
 * `Promise<Result<ExecutionResult, DomainError>>` using the `neverthrow`
 * pattern. AIP Logic must explicitly handle the error path.
 *
 * @module aip-logic/trigger-graph
 */

import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { ulid } from "ulid";

import type {
  ExecutionRequest,
  ExecutionResult,
  GraphName,
  DomainError,
  Logger,
} from "../orchestrator/src/core/types.js";
import { createLogger } from "../orchestrator/src/core/logger.js";
import { executeGraph } from "../orchestrator/src/graph/graph-runner.js";
import { loadConfig } from "../orchestrator/src/utils/config.js";

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * Trigger execution of a named agent graph.
 *
 * This is the primary entry point that AIP Logic functions call.
 *
 * @param graphName - The logical name of the graph to execute (e.g. "incident-triage")
 * @param input     - The input payload for the graph (arbitrary key-value pairs)
 * @param options   - Optional execution overrides
 * @returns An `AsyncDomainResult<ExecutionResult>` — `ok(result)` on success,
 *          `err(DomainError)` on failure.
 *
 * @example
 * ```typescript
 * const result = await triggerGraph("incident-triage", {
 *   incident_id: "01JABC123",
 *   raw_text: "Database replication lag on us-east-1",
 * });
 *
 * if (result.isOk()) {
 *   console.log("Graph completed:", result.value.status);
 *   console.log("Final state:", result.value.finalState);
 * } else {
 *   console.error("Graph failed:", result.error.message);
 * }
 * ```
 */
export async function triggerGraph(
  graphName: GraphName,
  input: Record<string, unknown>,
  options?: TriggerGraphOptions,
): Promise<Result<ExecutionResult, DomainError>> {
  const logger: Logger = createLogger({
    level: options?.logLevel ?? "info",
    component: "aip-logic",
  });

  const requestId = ulid();
  const startedAt = new Date().toISOString();

  logger.info(
    { requestId, graphName, inputKeys: Object.keys(input) },
    "AIP Logic triggering graph execution",
  );

  // Build the execution request
  const request: ExecutionRequest = {
    requestId: requestId as any, // branded type from core
    graphName,
    input,
    metadata: {
      triggeredBy: options?.triggeredBy ?? "aip-logic",
      triggerSource: options?.triggerSource ?? "manual",
      correlationId: options?.correlationId ?? requestId,
      startedAt,
    },
    options: {
      timeoutMs: options?.timeoutMs,
      persistCheckpoints: options?.persistCheckpoints ?? false,
      enableStreamEvents: options?.enableStreamEvents ?? true,
    },
  };

  // Load orchestrator configuration
  let config;
  try {
    const configResult = loadConfig(options?.configPath);
    if (configResult.isErr()) {
      logger.error({ err: configResult.error }, "Failed to load orchestrator config");
      return err(configResult.error);
    }
    config = configResult.value;
  } catch (error: unknown) {
    // If config loading throws, wrap it
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Config loading threw unexpectedly");
    return err(
      new (await import("../orchestrator/src/core/errors.js")).DomainError(
        `Configuration error: ${message}`,
        { code: "CONFIG_ERROR", retryable: false },
      ),
    );
  }

  // Execute the graph
  logger.info({ requestId, graphName }, "Calling orchestrator executeGraph");
  const result = await executeGraph(request, config, logger);

  if (result.isErr()) {
    logger.error(
      { requestId, graphName, err: result.error },
      "Graph execution failed",
    );
    return err(result.error);
  }

  logger.info(
    {
      requestId,
      graphName,
      status: result.value.status,
      durationMs: result.value.durationMs,
      nodesExecuted: result.value.nodeResults?.length,
    },
    "Graph execution completed successfully",
  );

  return ok(result.value);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for triggering a graph execution from AIP Logic.
 */
export interface TriggerGraphOptions {
  /** Override the log level for this execution */
  logLevel?: "debug" | "info" | "warn" | "error";

  /** Path to the orchestrator config file (defaults to env-aware path) */
  configPath?: string;

  /** Who or what triggered this execution */
  triggeredBy?: string;

  /** What system triggered this (e.g. "ontology-hook", "schedule", "manual") */
  triggerSource?: string;

  /** Correlation ID for tracing across systems */
  correlationId?: string;

  /** Maximum time (ms) to wait for graph completion */
  timeoutMs?: number;

  /** Enable durable checkpointing (Phase 3) */
  persistCheckpoints?: boolean;

  /** Emit per-hop events to Foundry Streams */
  enableStreamEvents?: boolean;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ExecutionRequest, ExecutionResult, GraphName, DomainError };
