/**
 * Foundry Event Emitter
 *
 * Publishes per-hop graph execution events to Foundry Streams for
 * observability, monitoring, and audit-trail purposes. Every node
 * lifecycle transition (start, complete, error, skip) is emitted as
 * a structured event on a configurable Foundry Stream.
 *
 * ## Event Types Emitted
 *
 * | Event                  | When                                  |
 * |------------------------|---------------------------------------|
 * | `graph.started`        | Graph execution begins                |
 * | `node.started`         | A single agent node begins execution  |
 * | `node.completed`       | An agent node finishes successfully   |
 * | `node.error`           | An agent node fails                   |
 * | `node.skipped`         | A conditional node is skipped         |
 * | `graph.completed`      | The entire graph finishes             |
 * | `graph.error`          | The graph terminates with an error    |
 * | `graph.node_checkpoint`| A durable-execution checkpoint is saved|
 */

import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import axios, { AxiosInstance, AxiosError } from "axios";
import { ulid } from "ulid";

import type { Logger } from "../../core/logger.js";
import type {
  GraphEvent,
  GraphEventType,
  GraphEventPayload,
  FoundryStreamConfig,
  GraphStateSnapshot,
  AgentResult,
  ExecutionResult,
} from "../../core/types.js";
import {
  DomainError,
  FoundryStreamError,
  NetworkError,
} from "../../core/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STREAM_PATH = "/api/v2/streams/orchestration-events";

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

/**
 * Publishes graph execution events to Foundry Streams.
 *
 * Each event is a typed `GraphEvent` that carries:
 * - The event type and timestamp
 * - The execution and graph identifiers
 * - Node-level detail (for node-scoped events)
 * - A correlation ID for tracing
 *
 * Events are fire-and-forget: emission failures are logged but do NOT
 * fail the graph execution. This ensures observability is non-blocking.
 */
export class EventEmitter {
  private readonly http: AxiosInstance;
  private readonly logger: Logger;
  private readonly streamPath: string;
  private readonly enabled: boolean;

  /**
   * @param config - Foundry Stream configuration
   * @param logger - Structured logger instance
   */
  constructor(config: FoundryStreamConfig, logger: Logger) {
    this.streamPath = config.streamPath ?? DEFAULT_STREAM_PATH;
    this.enabled = config.enabled ?? true;
    this.logger = logger.child({ component: "EventEmitter" });

    this.http = axios.create({
      baseURL: config.foundryUrl.replace(/\/+$/, ""),
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
  // Public API — Named event emitters
  // -----------------------------------------------------------------------

  /**
   * Emit a `graph.started` event.
   *
   * @param executionId - The unique execution identifier
   * @param graphName   - Logical name of the graph being executed
   * @param nodeCount   - Total number of nodes in the graph
   * @param input       - The initial input payload (sanitized)
   */
  async emitGraphStarted(
    executionId: string,
    graphName: string,
    nodeCount: number,
    input?: Record<string, unknown>,
  ): Promise<void> {
    await this.emit("graph.started", {
      executionId,
      graphName,
      nodeCount,
      input: sanitizePayload(input),
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `node.started` event.
   *
   * @param executionId - Execution identifier
   * @param graphName   - Graph name
   * @param nodeId      - The node being executed
   * @param agentName   - The logical agent name
   */
  async emitNodeStarted(
    executionId: string,
    graphName: string,
    nodeId: string,
    agentName: string,
  ): Promise<void> {
    await this.emit("node.started", {
      executionId,
      graphName,
      nodeId,
      agentName,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `node.completed` event.
   *
   * @param executionId - Execution identifier
   * @param graphName   - Graph name
   * @param nodeId      - The node that completed
   * @param agentName   - The logical agent name
   * @param result      - The agent's result (data summarized)
   * @param durationMs  - Wall-clock duration of the node execution
   */
  async emitNodeCompleted(
    executionId: string,
    graphName: string,
    nodeId: string,
    agentName: string,
    result: AgentResult,
    durationMs: number,
  ): Promise<void> {
    await this.emit("node.completed", {
      executionId,
      graphName,
      nodeId,
      agentName,
      status: result.status,
      dataSummary: summarizeForEvent(result.data),
      durationMs,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `node.error` event.
   *
   * @param executionId - Execution identifier
   * @param graphName   - Graph name
   * @param nodeId      - The node that errored
   * @param agentName   - The logical agent name
   * @param error       - The error that occurred
   * @param durationMs  - Wall-clock duration before failure
   */
  async emitNodeError(
    executionId: string,
    graphName: string,
    nodeId: string,
    agentName: string,
    error: DomainError,
    durationMs: number,
  ): Promise<void> {
    await this.emit("node.error", {
      executionId,
      graphName,
      nodeId,
      agentName,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
      durationMs,
      failedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `node.skipped` event (for conditional nodes that are not executed).
   *
   * @param executionId - Execution identifier
   * @param graphName   - Graph name
   * @param nodeId      - The node that was skipped
   * @param agentName   - The logical agent name
   * @param reason      - Why the node was skipped
   */
  async emitNodeSkipped(
    executionId: string,
    graphName: string,
    nodeId: string,
    agentName: string,
    reason: string,
  ): Promise<void> {
    await this.emit("node.skipped", {
      executionId,
      graphName,
      nodeId,
      agentName,
      reason,
      skippedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `graph.completed` event.
   *
   * @param result     - The final execution result
   * @param durationMs - Total graph execution time
   */
  async emitGraphCompleted(
    result: ExecutionResult,
    durationMs: number,
  ): Promise<void> {
    await this.emit("graph.completed", {
      executionId: result.executionId,
      graphName: result.graphName,
      status: result.status,
      nodesExecuted: result.nodeResults?.length ?? 0,
      nodesFailed: result.nodeResults?.filter((n) => n.status === "error").length ?? 0,
      durationMs,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a `graph.error` event.
   *
   * @param executionId - Execution identifier
   * @param graphName   - Graph name
   * @param error       - The error that terminated the graph
   * @param durationMs  - Duration before failure
   */
  async emitGraphError(
    executionId: string,
    graphName: string,
    error: DomainError,
    durationMs: number,
  ): Promise<void> {
    await this.emit("graph.error", {
      executionId,
      graphName,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      },
      durationMs,
      failedAt: new Date().toISOString(),
    });
  }

  /**
   * Emit a checkpoint event (Phase 3 — durable execution).
   *
   * @param snapshot - The state snapshot being checkpointed
   */
  async emitCheckpoint(snapshot: GraphStateSnapshot): Promise<void> {
    await this.emit("graph.node_checkpoint", {
      executionId: snapshot.executionId,
      graphName: (snapshot as any).graphName ?? "unknown",
      graphId: snapshot.graphId,
      checkpointedAt: new Date().toISOString(),
    });
  }

  // -----------------------------------------------------------------------
  // Core emit logic
  // -----------------------------------------------------------------------

  /**
   * Emit a single typed event to the configured Foundry Stream.
   *
   * This method is fire-and-forget: if emission fails, the error is logged
   * at WARN level but the Promise always resolves (never rejects). Graph
   * execution must never be blocked by observability failures.
   *
   * @param type    - The event type discriminator
   * @param payload - The event payload (type-specific)
   */
  private async emit(
    type: GraphEventType,
    payload: Omit<GraphEventPayload, "type" | "timestamp" | "eventId">,
  ): Promise<void> {
    if (!this.enabled) {
      this.logger.debug({ type }, "Event emission disabled — skipping");
      return;
    }

    const event: GraphEvent = {
      eventId: ulid(),
      type,
      timestamp: new Date().toISOString(),
      payload: payload as GraphEventPayload,
    };

    try {
      await this.http.post(this.streamPath, event, {
        headers: {
          "X-Correlation-Id": (payload as any).executionId ?? event.eventId,
        },
        timeout: DEFAULT_TIMEOUT_MS,
      });

      this.logger.debug(
        { eventId: event.eventId, type, executionId: (payload as any).executionId },
        "Graph event emitted to Foundry Stream",
      );
    } catch (error: unknown) {
      // Fire-and-forget: log but do not propagate
      const message = axios.isAxiosError(error) ? error.message : String(error);
      this.logger.warn(
        { eventId: event.eventId, type, error: message },
        "Failed to emit graph event to Foundry Stream (non-fatal)",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a payload for event emission by removing potentially sensitive
 * or overly large data.
 */
function sanitizePayload(payload?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && value.length > 200) {
      sanitized[key] = value.slice(0, 200) + "...";
    } else if (typeof value === "object" && value !== null) {
      sanitized[key] = "[object]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Create a short summary of agent result data for event emission.
 */
function summarizeForEvent(data?: Record<string, unknown>): Record<string, unknown> {
  if (!data) return {};
  const keys = Object.keys(data).slice(0, 10);
  const summary: Record<string, unknown> = {};
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 100) {
      summary[key] = value.slice(0, 100) + "...";
    } else if (typeof value === "object" && value !== null) {
      summary[key] = "[object]";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
