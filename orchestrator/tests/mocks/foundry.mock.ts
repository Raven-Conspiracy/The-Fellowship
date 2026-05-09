/**
 * Foundry Mock
 *
 * Mock implementations of Foundry adapters (`OntologyWriter` and
 * `EventEmitter`) for unit tests. These mocks capture calls and return
 * pre-programmed results without making real HTTP requests to Foundry.
 */

import { vi } from "vitest";
import { ok, err } from "neverthrow";
import type { Result } from "neverthrow";

import type {
  ExecutionResult,
  ExecutionRequest,
  GraphStateSnapshot,
  OntologyWriteResult,
  DomainError,
} from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Mock OntologyWriter
// ---------------------------------------------------------------------------

export interface MockOntologyWriter {
  writeResult: ReturnType<typeof vi.fn>;
  writeCheckpoint: ReturnType<typeof vi.fn>;
  mapResultToOntologyPayload: ReturnType<typeof vi.fn>;

  /** Set the return value for the next `writeResult` call */
  setNextWriteResult: (result: Result<OntologyWriteResult, DomainError>) => void;
  /** Get all results that were passed to `writeResult` */
  getWrittenResults: () => ExecutionResult[];
  /** Reset all mock state */
  reset: () => void;
}

/**
 * Create a mock `OntologyWriter` for unit testing.
 */
export function createMockOntologyWriter(): MockOntologyWriter {
  let nextWriteResult: Result<OntologyWriteResult, DomainError> = ok({
    objectRid: "mock-rid-001",
    actionType: "mock-action",
    writtenAt: new Date().toISOString(),
    correlationId: "mock-correlation-id",
  });
  const writtenResults: ExecutionResult[] = [];

  const writeResult = vi.fn(
    async (
      result: ExecutionResult,
      _triggerRequest: ExecutionRequest,
    ): Promise<Result<OntologyWriteResult, DomainError>> => {
      writtenResults.push(result);
      return nextWriteResult;
    },
  );

  const writeCheckpoint = vi.fn(
    async (_snapshot: GraphStateSnapshot): Promise<Result<OntologyWriteResult, DomainError>> => {
      return ok({
        objectRid: "mock-checkpoint-rid",
        actionType: "mock-action",
        writtenAt: new Date().toISOString(),
        correlationId: "mock-checkpoint",
      });
    },
  );

  const mapResultToOntologyPayload = vi.fn((result: ExecutionResult) => {
    return {
      graph_name: result.graphName,
      execution_id: result.executionId,
      status: result.status,
      started_at: result.startedAt,
      completed_at: result.completedAt,
    };
  });

  return {
    writeResult,
    writeCheckpoint,
    mapResultToOntologyPayload,

    setNextWriteResult(result: Result<OntologyWriteResult, DomainError>) {
      nextWriteResult = result;
    },

    getWrittenResults() {
      return [...writtenResults];
    },

    reset() {
      nextWriteResult = ok({
        objectRid: "mock-rid-001",
        actionType: "mock-action",
        writtenAt: new Date().toISOString(),
        correlationId: "mock-correlation-id",
      });
      writtenResults.length = 0;
      writeResult.mockClear();
      writeCheckpoint.mockClear();
      mapResultToOntologyPayload.mockClear();
    },
  };
}

// ---------------------------------------------------------------------------
// Mock EventEmitter
// ---------------------------------------------------------------------------

export interface MockEventEmitter {
  emitGraphStarted: ReturnType<typeof vi.fn>;
  emitNodeStarted: ReturnType<typeof vi.fn>;
  emitNodeCompleted: ReturnType<typeof vi.fn>;
  emitNodeError: ReturnType<typeof vi.fn>;
  emitNodeSkipped: ReturnType<typeof vi.fn>;
  emitGraphCompleted: ReturnType<typeof vi.fn>;
  emitGraphError: ReturnType<typeof vi.fn>;
  emitCheckpoint: ReturnType<typeof vi.fn>;

  /** Get all emitted events as an array of { eventType, args } */
  getEmittedEvents: () => Array<{ eventType: string; args: unknown[] }>;
  /** Reset all mock state */
  reset: () => void;
}

/**
 * Create a mock `EventEmitter` for unit testing.
 */
export function createMockEventEmitter(): MockEventEmitter {
  const emittedEvents: Array<{ eventType: string; args: unknown[] }> = [];

  function trackEmit(eventType: string) {
    return vi.fn((...args: unknown[]) => {
      emittedEvents.push({ eventType, args });
      return Promise.resolve();
    });
  }

  const emitGraphStarted = trackEmit("graph.started");
  const emitNodeStarted = trackEmit("node.started");
  const emitNodeCompleted = trackEmit("node.completed");
  const emitNodeError = trackEmit("node.error");
  const emitNodeSkipped = trackEmit("node.skipped");
  const emitGraphCompleted = trackEmit("graph.completed");
  const emitGraphError = trackEmit("graph.error");
  const emitCheckpoint = trackEmit("graph.node_checkpoint");

  return {
    emitGraphStarted,
    emitNodeStarted,
    emitNodeCompleted,
    emitNodeError,
    emitNodeSkipped,
    emitGraphCompleted,
    emitGraphError,
    emitCheckpoint,

    getEmittedEvents() {
      return [...emittedEvents];
    },

    reset() {
      emittedEvents.length = 0;
      emitGraphStarted.mockClear();
      emitNodeStarted.mockClear();
      emitNodeCompleted.mockClear();
      emitNodeError.mockClear();
      emitNodeSkipped.mockClear();
      emitGraphCompleted.mockClear();
      emitGraphError.mockClear();
      emitCheckpoint.mockClear();
    },
  };
}
