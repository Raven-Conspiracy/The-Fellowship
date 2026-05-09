/**
 * =============================================================================
 * ID Generator — ULID-based with Branded Types
 * =============================================================================
 *
 * Generates unique identifiers using ULID (Universally Unique Lexicographically
 * Sortable Identifier). ULIDs are:
 *   - Time-sortable (first 48 bits are a timestamp)
 *   - URL-safe (Crockford base32 encoding)
 *   - 26 characters long
 *   - Case-insensitive
 *   - Monotonically increasing within the same millisecond
 *
 * All generated IDs use branded types to prevent accidental misuse.
 */

import { ulid, monotonicFactory } from 'ulid';

import { AgentName, GraphName, ExecutionId, NodeId, IdempotencyKey } from '../core/types.js';

// ============================================================================
// ULID Generator
// ============================================================================

/**
 * Monotonic ULID factory — ensures IDs are monotonically increasing
 * even within the same millisecond. This is critical for database indexing
 * and deterministic ordering.
 */
const monotonicUlid = monotonicFactory();

/**
 * Generate a raw ULID string.
 *
 * @returns A 26-character ULID string
 */
export function generateUlid(): string {
  return monotonicUlid();
}

// ============================================================================
// Branded ID Generators
// ============================================================================

/**
 * Generate a unique ExecutionId for a graph execution.
 *
 * @returns A branded ExecutionId
 *
 * @example
 * ```typescript
 * const execId = generateExecutionId();
 * // execId is typed as ExecutionId, not a plain string
 * ```
 */
export function generateExecutionId(): ExecutionId {
  const raw = generateUlid();
  return ExecutionId(raw);
}

/**
 * Generate a unique NodeId for a node execution trace.
 *
 * @returns A branded NodeId
 *
 * @example
 * ```typescript
 * const nodeId = generateNodeId();
 * await tracer.startSpan(nodeId);
 * ```
 */
export function generateNodeId(): NodeId {
  const raw = generateUlid();
  return NodeId(raw);
}

/**
 * Generate an idempotency key for deduplication.
 * Uses ULID with a deterministic prefix for easy identification in logs.
 *
 * @param prefix - Optional prefix for the key
 * @returns A branded IdempotencyKey
 *
 * @example
 * ```typescript
 * const key = generateIdempotencyKey('triage');
 * // key looks like: "idem_01ARZ3NDEKTSV4RRFFQ69G5FAV"
 * ```
 */
export function generateIdempotencyKey(prefix?: string): IdempotencyKey {
  const raw = generateUlid();
  const key = prefix ? `idem_${prefix}_${raw}` : `idem_${raw}`;
  return IdempotencyKey(key);
}

// ============================================================================
// Prefixed ID Generators (for logging context)
// ============================================================================

/**
 * Prefix constants for different ID types.
 */
const PREFIX = {
  EXECUTION: 'exec',
  NODE: 'node',
  GRAPH: 'graph',
  AGENT: 'agent',
  IDEM: 'idem',
} as const;

/**
 * Generate a prefixed ExecutionId for better log readability.
 * Format: exec_<ULID>
 *
 * @returns A branded ExecutionId
 */
export function generatePrefixedExecutionId(): ExecutionId {
  return ExecutionId(`${PREFIX.EXECUTION}_${generateUlid()}`);
}

/**
 * Generate a prefixed NodeId for better log readability.
 * Format: node_<ULID>
 *
 * @returns A branded NodeId
 */
export function generatePrefixedNodeId(): NodeId {
  return NodeId(`${PREFIX.NODE}_${generateUlid()}`);
}

// ============================================================================
// ID Validation and Extraction
// ============================================================================

/**
 * Regular expression for validating ULID format.
 * ULID is exactly 26 characters of Crockford base32 (0-9, A-H, J-N, P-Z, a-h, j-n, p-z).
 */
const ULID_REGEX = /^[0-9A-HJ-NP-Za-hj-np-z]{26}$/;

/**
 * Check if a string is a valid ULID.
 *
 * @param value - The string to check
 * @returns true if the string is a valid ULID
 */
export function isValidUlid(value: string): boolean {
  return ULID_REGEX.test(value);
}

/**
 * Extract the timestamp from a ULID.
 * The first 10 characters of a ULID encode the timestamp in milliseconds.
 *
 * @param id - The ULID string
 * @returns The timestamp as a Date, or undefined if invalid
 */
export function extractTimestampFromUlid(id: string): Date | undefined {
  if (!isValidUlid(id)) {
    return undefined;
  }

  // Decode the first 10 characters (48 bits of timestamp)
  // Crockford base32 decoding
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const timePart = id.substring(0, 10).toUpperCase();

  let timestamp = 0;
  for (let i = 0; i < timePart.length; i++) {
    const char = timePart[i]!;
    const value = ENCODING.indexOf(char);
    if (value === -1) {
      return undefined;
    }
    timestamp = timestamp * 32 + value;
  }

  return new Date(timestamp);
}

/**
 * Extract the random portion from a ULID.
 *
 * @param id - The ULID string
 * @returns The random portion (last 16 characters), or undefined if invalid
 */
export function extractRandomFromUlid(id: string): string | undefined {
  if (!isValidUlid(id)) {
    return undefined;
  }
  return id.substring(10);
}

// ============================================================================
// Deterministic ID Generation (for idempotency)
// ============================================================================

/**
 * Generate a deterministic idempotency key from the graph name and input hash.
 * This ensures that identical requests produce the same idempotency key,
 * enabling natural deduplication without a separate key store.
 *
 * @param graphName - The graph name
 * @param input - The input payload
 * @returns A deterministic IdempotencyKey
 */
export function generateDeterministicIdempotencyKey(
  graphName: string,
  input: Record<string, unknown>,
): IdempotencyKey {
  const inputStr = JSON.stringify(input, Object.keys(input).sort());
  const hash = simpleHash(`${graphName}:${inputStr}`);
  const raw = generateUlid().substring(0, 10) + hash.substring(0, 16);
  return IdempotencyKey(`idem_${graphName}_${raw}`);
}

/**
 * Simple non-cryptographic hash function for deterministic ID generation.
 * Uses djb2 algorithm.
 *
 * @param str - The input string
 * @returns A hex-like hash string
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ============================================================================
// ID Comparison Utilities
// ============================================================================

/**
 * Compare two ULID-based IDs for ordering.
 * Since ULIDs are time-sortable, this is equivalent to comparing their timestamps.
 *
 * @param a - First ID
 * @param b - Second ID
 * @returns Negative if a < b, 0 if equal, positive if a > b
 */
export function compareUlids(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * Check if one ULID was generated after another.
 *
 * @param a - The ID to check
 * @param b - The reference ID
 * @returns true if a was generated after b
 */
export function isAfter(a: string, b: string): boolean {
  return compareUlids(a, b) > 0;
}

/**
 * Check if one ULID was generated before another.
 *
 * @param a - The ID to check
 * @param b - The reference ID
 * @returns true if a was generated before b
 */
export function isBefore(a: string, b: string): boolean {
  return compareUlids(a, b) < 0;
}
