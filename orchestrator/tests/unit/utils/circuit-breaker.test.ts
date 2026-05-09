/**
 * Circuit Breaker — Unit Tests
 *
 * Tests for the `CircuitBreaker`: CLOSED → OPEN → HALF_OPEN → CLOSED
 * state transitions, failure threshold, and reset timeout.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createMockLogger } from "../../mocks/logger.mock.js";
import type { MockLogger } from "../../mocks/logger.mock.js";

// ---------------------------------------------------------------------------
// Minimal CircuitBreaker (mirrors what Builder Agent 1 will create)
// ---------------------------------------------------------------------------

type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  logger?: MockLogger;
}

interface CircuitBreakerState {
  state: BreakerState;
  failureCount: number;
  lastFailureTime: number | null;
}

class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private failureCount = 0;
  private lastFailureTime: number | null = null;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private halfOpenAllowed = false;
  private readonly logger?: MockLogger;

  constructor(config: CircuitBreakerConfig) {
    this.failureThreshold = config.failureThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs;
    this.logger = config.logger;
  }

  isOpen(): boolean {
    if (this.state === "CLOSED") return false;

    if (this.state === "OPEN") {
      const elapsed = this.lastFailureTime ? Date.now() - this.lastFailureTime : 0;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = "HALF_OPEN";
        this.halfOpenAllowed = true;
        this.logger?.info("Circuit breaker transitioning OPEN → HALF_OPEN");
        return false; // Allow the probe request
      }
      return true; // Still OPEN, reject
    }

    // HALF_OPEN: allow first request, reject subsequent until success/failure
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenAllowed) {
        this.halfOpenAllowed = false;
        return false; // Allow the probe
      }
      return true; // Reject concurrent requests during HALF_OPEN
    }

    return false;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state !== "CLOSED") {
      this.logger?.info("Circuit breaker reset to CLOSED after successful probe");
    }
    this.state = "CLOSED";
    this.lastFailureTime = null;
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === "HALF_OPEN") {
      // Probe failed — go back to OPEN
      this.state = "OPEN";
      this.logger?.warn("Circuit breaker HALF_OPEN probe failed — returning to OPEN");
      return;
    }

    if (this.failureCount >= this.failureThreshold && this.state === "CLOSED") {
      this.state = "OPEN";
      this.logger?.warn(
        { failureCount: this.failureCount },
        "Circuit breaker opened after reaching failure threshold",
      );
    }
  }

  getState(): CircuitBreakerState {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAllowed = false;
    this.logger?.info("Circuit breaker manually reset to CLOSED");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100, // Short timeout for testing
      logger,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial state", () => {
    it("should start CLOSED", () => {
      expect(breaker.getState().state).toBe("CLOSED");
      expect(breaker.isOpen()).toBe(false);
    });

    it("should have zero failures", () => {
      expect(breaker.getState().failureCount).toBe(0);
    });
  });

  describe("CLOSED → OPEN transition", () => {
    it("should open after reaching failure threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(false); // Not yet

      breaker.recordFailure(); // Third failure
      expect(breaker.isOpen()).toBe(true);
      expect(breaker.getState().state).toBe("OPEN");
    });

    it("should not open before reaching threshold", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe("CLOSED");
      expect(breaker.isOpen()).toBe(false);
    });

    it("should reset failure count on success", () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordSuccess();

      expect(breaker.getState().failureCount).toBe(0);
      expect(breaker.getState().state).toBe("CLOSED");
    });
  });

  describe("OPEN → HALF_OPEN transition", () => {
    it("should transition to HALF_OPEN after reset timeout", async () => {
      // Force OPEN
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      // Advance time past reset timeout
      vi.advanceTimersByTime(150);

      // Now should be HALF_OPEN and allow one request
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.getState().state).toBe("HALF_OPEN");
    });

    it("should only allow one probe in HALF_OPEN", async () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      vi.advanceTimersByTime(150);

      // First call is allowed (probe)
      expect(breaker.isOpen()).toBe(false);

      // Second call should be rejected
      expect(breaker.isOpen()).toBe(true);
    });
  });

  describe("HALF_OPEN → CLOSED transition", () => {
    it("should close on successful probe", async () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      vi.advanceTimersByTime(150);

      // Probe succeeds
      breaker.isOpen(); // Allow probe
      breaker.recordSuccess();

      expect(breaker.getState().state).toBe("CLOSED");
      expect(breaker.getState().failureCount).toBe(0);
    });
  });

  describe("HALF_OPEN → OPEN (re-open)", () => {
    it("should go back to OPEN on failed probe", async () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      vi.advanceTimersByTime(150);

      // Probe fails
      breaker.isOpen(); // Allow probe
      breaker.recordFailure();

      expect(breaker.getState().state).toBe("OPEN");
    });
  });

  describe("reset", () => {
    it("should manually reset to CLOSED", () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure();
      expect(breaker.getState().state).toBe("OPEN");

      breaker.reset();
      expect(breaker.getState().state).toBe("CLOSED");
      expect(breaker.getState().failureCount).toBe(0);
    });
  });

  describe("custom thresholds", () => {
    it("should respect a custom failure threshold", () => {
      const b = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 1000 });

      for (let i = 0; i < 4; i++) b.recordFailure();
      expect(b.isOpen()).toBe(false);

      b.recordFailure(); // Fifth
      expect(b.isOpen()).toBe(true);
    });
  });
});
