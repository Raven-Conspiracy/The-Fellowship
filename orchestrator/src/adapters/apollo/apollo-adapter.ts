/**
 * Apollo Adapter
 *
 * Anti-corruption layer between the orchestrator's internal domain types and
 * Apollo's wire format. This is the **only** component that knows how to:
 *
 * 1. Translate an `AgentNodeDefinition` (our type) → `ApolloRequest` (Apollo's wire format)
 * 2. Translate an `ApolloResponse` (Apollo's wire format) → `AgentResult` (our type)
 *
 * No other module should import Apollo-specific types directly.
 */

import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';

import type { Logger } from '../../core/types.js';
import type {
  AgentNodeDefinition,
  AgentResult,
  GraphStateSnapshot,
  AgentInput,
  NodeId,
  AgentName,
  ExecutionId,
} from '../../core/types.js';
import { OrchestrationError, ApolloClientError } from '../../core/errors.js';
import { ApolloClient } from './apollo-client.js';
import type { ApolloEndpointConfig, ApolloRequest, ApolloResponse } from './apollo-client.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { ApolloEndpointConfig };

// ---------------------------------------------------------------------------
// ApolloAdapter
// ---------------------------------------------------------------------------

/**
 * Translates between orchestrator domain types and Apollo's HTTP wire format.
 */
export class ApolloAdapter {
  private readonly client: ApolloClient;
  private readonly logger: Logger;

  constructor(apolloConfig: ApolloEndpointConfig, logger: Logger) {
    this.logger = logger.child({ component: 'ApolloAdapter' });
    this.client = new ApolloClient(apolloConfig, this.logger);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute an agent node by translating it to an Apollo call and mapping
   * the response back to a domain `AgentResult`.
   */
  async executeNode(
    node: AgentNodeDefinition,
    state: GraphStateSnapshot,
  ): Promise<Result<AgentResult, OrchestrationError>> {
    // 1. Translate node → ApolloRequest
    const requestResult = this.buildRequest(node, state);
    if (requestResult.isErr()) {
      return err(requestResult.error);
    }

    const apolloRequest = requestResult.value;

    this.logger.info(
      `Executing agent node via Apollo adapter: node=${node.name} agent=${node.config.agentName}`,
    );

    // 2. Execute via ApolloClient
    const responseResult = await this.client.execute(apolloRequest);
    if (responseResult.isErr()) {
      this.logger.error(
        `Apollo execution failed for agent node: node=${node.name} error=${responseResult.error.message}`,
      );
      return err(responseResult.error);
    }

    // 3. Translate ApolloResponse → AgentResult
    const agentResult = this.mapResponse(responseResult.value, node);
    return ok(agentResult);
  }

  /** Perform a health check against the Apollo instance. */
  async healthCheck(): Promise<Result<boolean, OrchestrationError>> {
    return this.client.healthCheck();
  }

  /** Expose the underlying ApolloClient for monitoring purposes. */
  getClient(): ApolloClient {
    return this.client;
  }

  // -----------------------------------------------------------------------
  // Request Mapping
  // -----------------------------------------------------------------------

  /**
   * Build an `ApolloRequest` from an `AgentNodeDefinition` and the current state snapshot.
   */
  buildRequest(
    node: AgentNodeDefinition,
    state: GraphStateSnapshot,
  ): Result<ApolloRequest, OrchestrationError> {
    try {
      const payload = this.resolvePayload(node, state);

      const request: ApolloRequest = {
        agentRoute: node.config.apolloRoute,
        payload,
        metadata: {
          nodeName: node.name,
          agentName: node.config.agentName,
          graphName: state.graphName,
          executionId: state.executionId,
        },
      };

      this.logger.debug(`Built Apollo request: node=${node.name} route=${node.config.apolloRoute}`);

      return ok(request);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new ApolloClientError(
          `Failed to build Apollo request for node ${node.name}: ${message}`,
          node.config.apolloRoute,
          { context: { nodeName: node.name }, cause: error instanceof Error ? error : undefined },
        ),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Response Mapping
  // -----------------------------------------------------------------------

  /**
   * Map a raw `ApolloResponse` into a domain `AgentResult`.
   */
  mapResponse(response: ApolloResponse, node: AgentNodeDefinition): AgentResult {
    const now = new Date().toISOString();

    const result: AgentResult = {
      nodeId: node.name as unknown as NodeId,
      agentName: node.config.agentName,
      output: response.data ?? {},
      durationMs: 0,
      retryCount: 0,
      startedAt: now,
      completedAt: now,
      success: response.status !== 'error',
      errorMessage: response.error?.message,
    };

    this.logger.debug(
      `Mapped Apollo response to AgentResult: node=${node.name} success=${result.success}`,
    );

    return result;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the payload for a Striveworks agent call.
   * Uses the node's `inputTransform` if configured, otherwise forwards
   * the full state snapshot.
   */
  private resolvePayload(node: AgentNodeDefinition, state: GraphStateSnapshot): AgentInput {
    // If the node has an input transform, use it
    if (node.inputTransform) {
      return node.inputTransform(state as any); // ReadonlyGraphState
    }

    // Default: forward full state as input
    return {
      state: state.nodeOutputs as unknown as Record<string, unknown>,
      graph_context: {
        graphName: state.graphName,
        executionId: state.executionId,
        nodeName: node.name,
        agentName: node.config.agentName,
      },
    };
  }
}
