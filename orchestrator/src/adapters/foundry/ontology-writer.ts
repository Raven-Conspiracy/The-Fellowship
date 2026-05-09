/**
 * Foundry Ontology Writer
 *
 * Writes the final `ExecutionResult` (or intermediate checkpoints) to the
 * Foundry Ontology via Foundry Action Types. This adapter is the **only**
 * component that knows how to map internal `GraphStateSnapshot` data into
 * Ontology-compatible payloads.
 *
 * In Phase 1, only the final result is written. In Phase 3, per-node
 * checkpoints are written to a Foundry dataset for durable execution.
 */

import { err, ok } from "neverthrow";
import type { Result, ResultAsync } from "neverthrow";
import axios, { AxiosInstance, AxiosError } from "axios";
import { ulid } from "ulid";

import type { Logger } from "../../core/logger.js";
import type {
  ExecutionResult,
  GraphStateSnapshot,
  ExecutionRequest,
  OntologyWritePayload,
  FoundryActionTypeConfig,
  OntologyWriteResult,
} from "../../core/types.js";
import {
  DomainError,
  FoundryWriteError,
  FoundryAuthError,
  NetworkError,
} from "../../core/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TYPE = "orchestration-graph-result";

// ---------------------------------------------------------------------------
// OntologyWriter
// ---------------------------------------------------------------------------

/**
 * Writes orchestration results to the Foundry Ontology.
 *
 * Converts an `ExecutionResult` into the Ontology object format expected by
 * the configured Foundry Action Type, then POSTs it via the Foundry API.
 *
 * ## Action Type Payload Structure
 *
 * The Ontology object written follows a canonical schema:
 * ```json
 * {
 *   "graph_name": "incident-triage",
 *   "execution_id": "01J...",
 *   "status": "completed",
 *   "started_at": "2026-05-01T12:00:00Z",
 *   "completed_at": "2026-05-01T12:00:05Z",
 *   "nodes_executed": 4,
 *   "nodes_failed": 0,
 *   "final_state": { ... },
 *   "errors": []
 * }
 * ```
 */
export class OntologyWriter {
  private readonly http: AxiosInstance;
  private readonly logger: Logger;
  private readonly actionType: string;
  private readonly foundryUrl: string;

  /**
   * @param config - Foundry Action Type configuration
   * @param logger - Structured logger instance
   */
  constructor(config: FoundryActionTypeConfig, logger: Logger) {
    this.foundryUrl = config.foundryUrl.replace(/\/+$/, "");
    this.actionType = config.actionType ?? DEFAULT_ACTION_TYPE;
    this.logger = logger.child({ component: "OntologyWriter" });

    this.http = axios.create({
      baseURL: this.foundryUrl,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${config.foundryToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "The-Fellowship-Orchestrator/0.1.0",
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Write the final execution result to the Foundry Ontology.
   *
   * @param result        - The completed `ExecutionResult` to persist
   * @param triggerRequest - The original `ExecutionRequest` that started the graph
   * @returns A `Result` with `OntologyWriteResult` containing the Ontology
   *          object RID or a `DomainError`.
   */
  async writeResult(
    result: ExecutionResult,
    triggerRequest: ExecutionRequest,
  ): Promise<Result<OntologyWriteResult, DomainError>> {
    const correlationId = ulid();

    const payload = this.mapResultToOntologyPayload(result, triggerRequest, correlationId);

    this.logger.info(
      {
        correlationId,
        graphName: result.graphName,
        executionId: result.executionId,
        actionType: this.actionType,
      },
      "Writing execution result to Foundry Ontology",
    );

    try {
      const response = await this.http.post(
        `/api/v2/actions/${encodeURIComponent(this.actionType)}`,
        payload,
        {
          headers: {
            "X-Correlation-Id": correlationId,
          },
        },
      );

      const writeResult: OntologyWriteResult = {
        objectRid: response.data?.rid ?? `unknown-${correlationId}`,
        actionType: this.actionType,
        writtenAt: new Date().toISOString(),
        correlationId,
      };

      this.logger.info(
        { correlationId, objectRid: writeResult.objectRid },
        "Successfully wrote result to Foundry Ontology",
      );

      return ok(writeResult);
    } catch (error: unknown) {
      return this.handleWriteError(error as AxiosError | Error, correlationId);
    }
  }

  /**
   * Write a checkpoint snapshot to the Ontology (Phase 3 — durable execution).
   *
   * @param snapshot - The current `GraphStateSnapshot` to checkpoint
   * @returns `ok(OntologyWriteResult)` or `err(DomainError)`
   */
  async writeCheckpoint(
    snapshot: GraphStateSnapshot,
  ): Promise<Result<OntologyWriteResult, DomainError>> {
    const correlationId = ulid();

    this.logger.debug(
      { correlationId, executionId: snapshot.executionId, graphId: snapshot.graphId },
      "Writing checkpoint to Foundry Ontology",
    );

    try {
      const response = await this.http.post(
        `/api/v2/actions/${encodeURIComponent(this.actionType)}/checkpoint`,
        {
          execution_id: snapshot.executionId,
          graph_id: snapshot.graphId,
          state: snapshot,
          checkpointed_at: new Date().toISOString(),
        },
        {
          headers: {
            "X-Correlation-Id": correlationId,
          },
        },
      );

      const writeResult: OntologyWriteResult = {
        objectRid: response.data?.rid ?? `checkpoint-${correlationId}`,
        actionType: this.actionType,
        writtenAt: new Date().toISOString(),
        correlationId,
      };

      return ok(writeResult);
    } catch (error: unknown) {
      return this.handleWriteError(error as AxiosError | Error, correlationId);
    }
  }

  // -----------------------------------------------------------------------
  // Payload Mapping
  // -----------------------------------------------------------------------

  /**
   * Map an `ExecutionResult` + `ExecutionRequest` into an Ontology-compatible
   * action type payload.
   *
   * @param result          - The final execution result
   * @param triggerRequest  - The original trigger request
   * @param correlationId   - Correlation ID for tracing
   */
  mapResultToOntologyPayload(
    result: ExecutionResult,
    triggerRequest: ExecutionRequest,
    correlationId: string,
  ): OntologyWritePayload {
    const snapshot = result.finalState;

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
        duration_ms: nr.metadata?.durationMs,
      })),
      final_state: snapshot ?? {},
      errors: result.errors?.map((e) => ({
        code: e.code,
        message: e.message,
        node_id: (e as any).nodeId,
      })),
      metadata: {
        correlation_id: correlationId,
        graph_version: result.graphVersion ?? "0.1.0",
        orchestrator_version: "0.1.0",
      },
    };
  }

  // -----------------------------------------------------------------------
  // Error Handling
  // -----------------------------------------------------------------------

  private handleWriteError(
    error: AxiosError | Error,
    correlationId: string,
  ): ReturnType<typeof err<OntologyWriteResult, DomainError>> {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      if (status === 401 || status === 403) {
        this.logger.error(
          { correlationId, status },
          "Foundry authentication failed during Ontology write",
        );
        return err(
          new FoundryAuthError("Foundry authentication failed — check FOUNDRY_TOKEN", {
            correlationId,
            status,
            cause: error,
          }),
        );
      }

      if (!error.response) {
        this.logger.error(
          { correlationId, message: error.message },
          "Network error during Ontology write",
        );
        return err(
          new NetworkError(`Network error writing to Foundry Ontology: ${error.message}`, {
            correlationId,
            cause: error,
          }),
        );
      }

      this.logger.error(
        { correlationId, status, data: error.response.data },
        "Foundry Ontology write failed",
      );
      return err(
        new FoundryWriteError(
          `Foundry Ontology write failed (HTTP ${status}): ${error.message}`,
          {
            correlationId,
            status,
            detail: error.response.data as Record<string, unknown>,
            cause: error,
          },
        ),
      );
    }

    this.logger.error(
      { correlationId, message: error.message },
      "Unexpected error during Ontology write",
    );
    return err(
      new FoundryWriteError(`Unexpected error writing to Foundry Ontology: ${error.message}`, {
        correlationId,
        cause: error,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a short summary of agent result data for Ontology storage.
 * Limits the size to prevent overly large Ontology objects.
 */
function summarizeData(data: Record<string, unknown> | undefined, maxKeys = 20): Record<string, unknown> {
  if (!data) return {};

  const keys = Object.keys(data).slice(0, maxKeys);
  const summary: Record<string, unknown> = {};

  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 500) {
      summary[key] = value.slice(0, 500) + "... [truncated]";
    } else if (typeof value === "object" && value !== null) {
      summary[key] = "[object]";
    } else {
      summary[key] = value;
    }
  }

  if (Object.keys(data).length > maxKeys) {
    summary["_truncated"] = `${Object.keys(data).length - maxKeys} additional keys omitted`;
  }

  return summary;
}
