/**
 * Apollo Adapter
 *
 * Anti-corruption layer between the orchestrator's internal domain types and
 * Apollo's wire format. This is the **only** component that knows how to:
 *
 * 1. Translate an `AgentNode` (our type) → `ApolloRequest` (Apollo's wire format)
 * 2. Translate an `ApolloResponse` (Apollo's wire format) → `AgentResult` (our type)
 *
 * No other module should import Apollo-specific types directly. All Apollo
 * communication flows through this adapter and the underlying `ApolloClient`.
 */

import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";

import type { Logger } from "../../core/logger.js";
import type {
  AgentNode,
  AgentNodeConfig,
  AgentResult,
  ApolloRequest,
  ApolloResponse,
  GraphState,
} from "../../core/types.js";
import { DomainError, ApolloAdapterError } from "../../core/errors.js";
import { ApolloClient } from "./apollo-client.js";
import type { ApolloEndpointConfig } from "./apollo-client.js";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ApolloEndpointConfig };

// ---------------------------------------------------------------------------
// ApolloAdapter
// ---------------------------------------------------------------------------

/**
 * Translates between orchestrator domain types and Apollo's HTTP wire format.
 *
 * ## Responsibilities
 * - **Request mapping:** Converts an `AgentNode` + current `GraphState` into
 *   an `ApolloRequest` suitable for the Apollo HTTP client.
 * - **Response mapping:** Converts the raw `ApolloResponse` from Apollo into
 *   a typed `AgentResult` for downstream graph execution.
 * - **Payload construction:** Builds the JSON payload that the Striveworks
 *   agent expects, based on the node's input mapping configuration.
 * - **Error wrapping:** Wraps any translation failures into `ApolloAdapterError`.
 */
export class ApolloAdapter {
  private readonly client: ApolloClient;
  private readonly logger: Logger;

  /**
   * @param apolloConfig - Apollo endpoint configuration
   * @param logger       - Structured logger instance
   */
  constructor(apolloConfig: ApolloEndpointConfig, logger: Logger) {
    this.logger = logger.child({ component: "ApolloAdapter" });
    this.client = new ApolloClient(apolloConfig, this.logger);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute an agent node by translating it to an Apollo call and mapping
   * the response back to a domain `AgentResult`.
   *
   * @param node  - The agent node to execute
   * @param state - The current graph state (used to resolve input mappings)
   * @returns A `Result` with `AgentResult` on success or `DomainError` on failure
   */
  async executeNode(node: AgentNode, state: GraphState): Promise<Result<AgentResult, DomainError>> {
    // 1. Translate node → ApolloRequest
    const requestResult = this.buildRequest(node, state);
    if (requestResult.isErr()) {
      return err(requestResult.error);
    }

    const apolloRequest = requestResult.value;

    this.logger.info(
      { nodeId: node.id, agentName: node.config.agentName, agentRoute: apolloRequest.agentRoute },
      "Executing agent node via Apollo adapter",
    );

    // 2. Execute via ApolloClient
    const responseResult = await this.client.execute(apolloRequest);
    if (responseResult.isErr()) {
      this.logger.error(
        { nodeId: node.id, err: responseResult.error },
        "Apollo execution failed for agent node",
      );
      return err(responseResult.error);
    }

    // 3. Translate ApolloResponse → AgentResult
    const agentResult = this.mapResponse(responseResult.value, node);
    return ok(agentResult);
  }

  /**
   * Perform a health check against the Apollo instance.
   */
  async healthCheck(): Promise<Result<boolean, DomainError>> {
    return this.client.healthCheck();
  }

  /**
   * Expose the underlying ApolloClient for monitoring purposes.
   */
  getClient(): ApolloClient {
    return this.client;
  }

  // -----------------------------------------------------------------------
  // Request Mapping
  // -----------------------------------------------------------------------

  /**
   * Build an `ApolloRequest` from an `AgentNode` and the current `GraphState`.
   *
   * Resolves the node's `inputMapping` to construct the payload that the
   * Striveworks agent expects. If `inputMapping` is not configured, the
   * entire current state snapshot is forwarded.
   *
   * @param node  - The agent node to translate
   * @param state - The current execution state
   * @returns A `Result` with the `ApolloRequest` or an `ApolloAdapterError`
   */
  buildRequest(node: AgentNode, state: GraphState): Result<ApolloRequest, DomainError> {
    try {
      const payload = this.resolvePayload(node.config, state);
      const agentRoute = node.config.endpoint.route;

      const request: ApolloRequest = {
        agentRoute,
        payload,
        metadata: {
          nodeId: node.id,
          agentName: node.config.agentName,
          graphId: state.graphId,
          executionId: state.executionId,
        },
      };

      this.logger.debug(
        { nodeId: node.id, agentRoute, payloadKeys: Object.keys(payload) },
        "Built Apollo request",
      );

      return ok(request);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new ApolloAdapterError(`Failed to build Apollo request for node ${node.id}: ${message}`, {
          nodeId: node.id,
          agentName: node.config.agentName,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Response Mapping
  // -----------------------------------------------------------------------

  /**
   * Map a raw `ApolloResponse` from the Apollo API into a domain `AgentResult`.
   *
   * The response is expected to conform to a standard envelope:
   * ```
   * {
   *   status: "success" | "error",
   *   data: { ... },        // agent-specific output
   *   metadata: { ... }     // optional metadata
   * }
   * ```
   *
   * @param response - The raw Apollo HTTP response body
   * @param node     - The agent node that was executed (for metadata)
   * @returns A typed `AgentResult`
   */
  mapResponse(response: ApolloResponse, node: AgentNode): AgentResult {
    const agentResult: AgentResult = {
      nodeId: node.id,
      agentName: node.config.agentName,
      status: response.status === "error" ? "error" : "success",
      data: response.data ?? {},
      metadata: {
        ...(response.metadata ?? {}),
        apolloRequestId: response.requestId,
        processedAt: new Date().toISOString(),
      },
      error: response.error
        ? {
            code: response.error.code ?? "UNKNOWN",
            message: response.error.message ?? "Unknown agent error",
            detail: response.error.detail,
          }
        : undefined,
    };

    this.logger.debug(
      { nodeId: node.id, status: agentResult.status },
      "Mapped Apollo response to AgentResult",
    );

    return agentResult;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the payload for a Striveworks agent call.
   *
   * If the node configuration specifies `inputMapping`, those keys are
   * extracted from `GraphState`. Otherwise the full state is forwarded.
   *
   * This method also injects a `graph_context` block with metadata that
   * Striveworks agents may use for logging/tracing.
   */
  private resolvePayload(config: AgentNodeConfig, state: GraphState): Record<string, unknown> {
    const snapshot = state.snapshot();

    // If the node has explicit input mappings, resolve them
    if (config.inputMapping && config.inputMapping.length > 0) {
      const resolved: Record<string, unknown> = {};
      for (const key of config.inputMapping) {
        if (key in snapshot) {
          resolved[key] = snapshot[key];
        }
      }
      return {
        ...resolved,
        graph_context: {
          graphId: state.graphId,
          executionId: state.executionId,
          nodeId: config.id,
          agentName: config.agentName,
        },
      };
    }

    // No explicit mapping → forward full state
    return {
      state: snapshot,
      graph_context: {
        graphId: state.graphId,
        executionId: state.executionId,
        nodeId: config.id,
        agentName: config.agentName,
      },
    };
  }
}
