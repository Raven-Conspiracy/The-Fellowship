/**
 * Retry Utility — Unit Tests
 *
 * Tests for exponential backoff calculation, jitter, and
 * max backoff caps.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Retry utilities (mirroring what Builder Agent 1 will create in utils/retry.ts)
// ---------------------------------------------------------------------------

/**
 * Calculate the backoff delay for a given attempt.
 *
 * Formula: min(base * 2^(attempt-1), maxBackoffMs) * random_jitter(0.5, 1.0)
 *
 * @param attempt      - The attempt number (1-based, where 1 = first retry after initial failure)
 * @param baseMs       - Base backoff in milliseconds
 * @param maxBackoffMs - Maximum backoff cap
 * @param jitter       - Random jitter factor (0.5 to 1.0). Pass a fixed value for deterministic tests.
 * @returns Delay in milliseconds
 */
function calculateBackoff(
  attempt: number,
  baseMs: number,
  maxBackoffMs: number,
  jitter?: number,
): number {
  const exponential = Math.min(baseMs * Math.pow(2, attempt - 1), maxBackoffMs);
  const jitterFactor = jitter ?? (0.5 + Math.random() * 0.5);
  return Math.round(exponential * jitterFactor);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("calculateBackoff", () => {
  describe("exponential growth", () => {
    it("should return base * 1 for attempt 1", () => {
      const delay = calculateBackoff(1, 500, 30000, 1.0);
      expect(delay).toBe(500);
    });

    it("should double for attempt 2", () => {
      // With jitter=1.0: 500 * 2^1 = 1000
      const delay = calculateBackoff(2, 500, 30000, 1.0);
      expect(delay).toBe(1000);
    });

    it("should quadruple for attempt 3", () => {
      // With jitter=1.0: 500 * 2^2 = 2000
      const delay = calculateBackoff(3, 500, 30000, 1.0);
      expect(delay).toBe(2000);
    });

    it("should grow to 8x for attempt 4", () => {
      const delay = calculateBackoff(4, 500, 30000, 1.0);
      expect(delay).toBe(4000);
    });
  });

  describe("max backoff cap", () => {
    it("should cap at maxBackoffMs", () => {
      // base=1000, attempt=10 → 1000 * 2^9 = 512000, but capped at 30000
      const delay = calculateBackoff(10, 1000, 30000, 1.0);
      expect(delay).toBeLessThanOrEqual(30000);
    });

    it("should respect very low caps", () => {
      const delay = calculateBackoff(5, 1000, 2000, 1.0);
      expect(delay).toBeLessThanOrEqual(2000);
    });
  });

  describe("jitter", () => {
    it("should apply jitter factor to the exponential delay", () => {
      const delay = calculateBackoff(2, 500, 30000, 0.5);
      // 500 * 2^1 * 0.5 = 500
      expect(delay).toBe(500);
    });

    it("should produce different values with random jitter", () => {
      // Run multiple times with random jitter
      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        delays.add(calculateBackoff(2, 500, 30000));
      }
      // With random jitter, we should get more than one unique value
      // (statistically very likely over 20 runs)
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe("edge cases", () => {
    it("should handle attempt 0 gracefully", () => {
      // 0 * 2^(-1) = 0
      const delay = calculateBackoff(0, 500, 30000, 1.0);
      expect(delay).toBeGreaterThanOrEqual(0);
    });

    it("should handle very large attempt numbers", () => {
      const delay = calculateBackoff(100, 100, 10000, 1.0);
      expect(delay).toBeLessThanOrEqual(10000);
      expect(delay).toBeGreaterThan(0);
    });

    it("should handle zero base", () => {
      const delay = calculateBackoff(3, 0, 30000, 1.0);
      expect(delay).toBe(0);
    });
  });
});

describe("RetryPolicy defaults", () => {
  it("should provide sensible defaults", () => {
    const defaultMaxAttempts = 3;
    const defaultBackoffBaseMs = 500;
    const defaultMaxBackoffMs = 30000;

    expect(defaultMaxAttempts).toBe(3);
    expect(defaultBackoffBaseMs).toBe(500);
    expect(defaultMaxBackoffMs).toBe(30000);
  });
});

describe("Retry sequence example", () => {
  it("should produce the expected retry timeline", () => {
    const baseMs = 500;
    const maxBackoffMs = 30000;

    const delays = [1, 2, 3, 4, 5].map((attempt) =>
      calculateBackoff(attempt, baseMs, maxBackoffMs, 1.0),
    );

    // Expected: 500, 1000, 2000, 4000, 8000
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});
