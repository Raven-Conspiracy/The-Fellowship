/**
 * =============================================================================
 * Circuit Breaker — State Machine
 * =============================================================================
 *
 * Implements the classic circuit breaker pattern as a finite state machine:
 *
 *   CLOSED ──(failures >= threshold)──▶ OPEN
 *     ▲                                   │
 *     │                          (cooldown elapsed)
 *     │                                   │
 *     └──(success in HALF_OPEN)── HALF_OPEN
 *              │
 *              └──(failure in HALF_OPEN)──▶ OPEN
 *
 * States:
 *   CLOSED    — Normal operation. Requests pass through.
 *   OPEN      — Circuit is tripped. Requests are rejected immediately.
 *   HALF_OPEN — Testing if the underlying issue is resolved.
 *               Limited number of requests allowed through.
 *
 * Thread-safe considerations:
 *   This is a single-threaded JS implementation. For multi-process scenarios,
 *   external state storage (e.g., Redis) would be needed.
 */

import { CircuitBreakerState } from '../core/types.js';
import type { CircuitBreakerConfig } from '../core/types.js';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from '../core/types.js';
import { CircuitBreakerOpenError } from '../core/errors.js';
import type { Logger } from '../core/types.js';

// ============================================================================
// Circuit Breaker State Machine
// ============================================================================

/**
 * Circuit breaker implementation with state machine semantics.
 */
export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly logger?: Logger;

  /** Current state of the circuit breaker */
  private _state: CircuitBreakerState = CircuitBreakerState.CLOSED;

  /** Number of consecutive failures in the current window */
  private _failureCount: number = 0;

  /** Timestamp when the circuit transitioned to OPEN (ISO 8601) */
  private _openedAt: string | null = null;

  /** Number of requests allowed through in HALF_OPEN state */
  private _halfOpenRequestCount: number = 0;

  /** Timestamp of the last state transition (ISO 8601) */
  private _lastTransitionAt: string;

  /**
   * @param config - Circuit breaker configuration
   * @param logger - Optional logger for state transitions
   */
  constructor(
    config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
    logger?: Logger,
  ) {
    this.config = config;
    this.logger = logger;
    this._lastTransitionAt = new Date().toISOString();
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Attempt to execute an operation through the circuit breaker.
   * If the circuit is OPEN, throws CircuitBreakerOpenError immediately.
   * If the circuit is HALF_OPEN, only allows a limited number of requests.
   * If the circuit is CLOSED, always allows the request.
   *
   * @param fn - The async function to execute
   * @returns A promise that resolves with the function's return value
   * @throws CircuitBreakerOpenError if the circuit is OPEN
   * @throws The original error if the operation fails
   *
   * @example
   * ```typescript
   * const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30000, halfOpenMaxRequests: 3 });
   * const result = await breaker.call(async () => {
   *   const res = await fetch('https://api.example.com');
   *   return res.json();
   * });
   * ```
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can allow this request through
    if (!this._canExecute()) {
      const error = new CircuitBreakerOpenError(
        'unknown',
        this._openedAt ?? this._lastTransitionAt,
      );
      throw error;
    }

    try {
      const result = await fn();

      // Success — record it
      this._onSuccess();

      return result;
    } catch (error) {
      // Failure — record it
      this._onFailure();

      throw error;
    }
  }

  /**
   * Get the current circuit breaker state.
   */
  get state(): CircuitBreakerState {
    this._checkStateTransition();
    return this._state;
  }

  /**
   * Get the number of consecutive failures.
   */
  get failureCount(): number {
    return this._failureCount;
  }

  /**
   * Get whether the circuit is currently OPEN (rejecting requests).
   */
  isOpen(): boolean {
    this._checkStateTransition();
    return this._state === CircuitBreakerState.OPEN;
  }

  /**
   * Get whether the circuit is CLOSED (allowing requests).
   */
  isClosed(): boolean {
    this._checkStateTransition();
    return this._state === CircuitBreakerState.CLOSED;
  }

  /**
   * Get whether the circuit is HALF_OPEN (testing the waters).
   */
  isHalfOpen(): boolean {
    this._checkStateTransition();
    return this._state === CircuitBreakerState.HALF_OPEN;
  }

  /**
   * Manually reset the circuit breaker to CLOSED state.
   * Useful for testing or manual intervention.
   */
  reset(): void {
    this._transitionTo(CircuitBreakerState.CLOSED);
    this._failureCount = 0;
    this._openedAt = null;
    this._halfOpenRequestCount = 0;
  }

  /**
   * Force the circuit to OPEN (e.g., when detecting an outage).
   */
  trip(): void {
    this._transitionTo(CircuitBreakerState.OPEN);
    this._openedAt = new Date().toISOString();
    this._halfOpenRequestCount = 0;
  }

  /**
   * Get a snapshot of the current breaker state for monitoring.
   */
  snapshot(): CircuitBreakerSnapshot {
    this._checkStateTransition();
    return {
      state: this._state,
      failureCount: this._failureCount,
      openedAt: this._openedAt,
      halfOpenRequestCount: this._halfOpenRequestCount,
      lastTransitionAt: this._lastTransitionAt,
      config: this.config,
    };
  }

  // ==========================================================================
  // Private State Machine Logic
  // ==========================================================================

  /**
   * Determine if a request is allowed through the circuit.
   * Also handles automatic state transitions (OPEN → HALF_OPEN).
   */
  private _canExecute(): boolean {
    this._checkStateTransition();

    switch (this._state) {
      case CircuitBreakerState.CLOSED:
        return true;

      case CircuitBreakerState.OPEN:
        return false;

      case CircuitBreakerState.HALF_OPEN:
        // In HALF_OPEN, only allow up to `halfOpenMaxRequests` through
        return this._halfOpenRequestCount < this.config.halfOpenMaxRequests;

      default:
        return false;
    }
  }

  /**
   * Record a successful execution.
   * Transitions HALF_OPEN → CLOSED if applicable.
   */
  private _onSuccess(): void {
    switch (this._state) {
      case CircuitBreakerState.CLOSED:
        // Reset failure count on success
        this._failureCount = 0;
        break;

      case CircuitBreakerState.HALF_OPEN:
        // Success in HALF_OPEN → CLOSED
        this._transitionTo(CircuitBreakerState.CLOSED);
        this._failureCount = 0;
        this._openedAt = null;
        this._halfOpenRequestCount = 0;
        break;

      case CircuitBreakerState.OPEN:
        // Shouldn't reach here — _canExecute would have blocked it
        break;
    }
  }

  /**
   * Record a failed execution.
   * Transitions CLOSED → OPEN if threshold reached.
   * Transitions HALF_OPEN → OPEN immediately on any failure.
   */
  private _onFailure(): void {
    this._failureCount++;

    switch (this._state) {
      case CircuitBreakerState.CLOSED:
        if (this._failureCount >= this.config.failureThreshold) {
          this._transitionTo(CircuitBreakerState.OPEN);
          this._openedAt = new Date().toISOString();
          this._halfOpenRequestCount = 0;
        }
        break;

      case CircuitBreakerState.HALF_OPEN:
        // Any failure in HALF_OPEN → back to OPEN
        this._transitionTo(CircuitBreakerState.OPEN);
        this._openedAt = new Date().toISOString();
        this._halfOpenRequestCount = 0;
        break;

      case CircuitBreakerState.OPEN:
        // Shouldn't reach here — _canExecute would have blocked it
        break;
    }
  }

  /**
   * Check if a timed state transition is needed (OPEN → HALF_OPEN after cooldown).
   */
  private _checkStateTransition(): void {
    if (
      this._state === CircuitBreakerState.OPEN &&
      this._openedAt !== null
    ) {
      const openedTime = new Date(this._openedAt).getTime();
      const cooldownElapsed = Date.now() - openedTime >= this.config.cooldownMs;

      if (cooldownElapsed) {
        this._transitionTo(CircuitBreakerState.HALF_OPEN);
        this._halfOpenRequestCount = 0;
      }
    }
  }

  /**
   * Perform a state transition with logging.
   */
  private _transitionTo(newState: CircuitBreakerState): void {
    const oldState = this._state;
    if (oldState === newState) {
      return;
    }

    this._state = newState;
    this._lastTransitionAt = new Date().toISOString();

    this.logger?.warn('Circuit breaker state changed', {
      oldState,
      newState,
      failureCount: this._failureCount,
      openedAt: this._openedAt,
      transitionAt: this._lastTransitionAt,
    });
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * A read-only snapshot of circuit breaker state for monitoring.
 */
export interface CircuitBreakerSnapshot {
  /** Current state */
  readonly state: CircuitBreakerState;
  /** Consecutive failure count */
  readonly failureCount: number;
  /** When the circuit opened, if applicable */
  readonly openedAt: string | null;
  /** Number of requests let through in HALF_OPEN */
  readonly halfOpenRequestCount: number;
  /** Timestamp of last state transition */
  readonly lastTransitionAt: string;
  /** The configuration used */
  readonly config: CircuitBreakerConfig;
}

// ============================================================================
// Circuit Breaker Registry
// ============================================================================

/**
 * A registry of circuit breakers keyed by agent name.
 * Used to manage circuit breakers for multiple agents.
 */
export class CircuitBreakerRegistry {
  private readonly breakers: Map<string, CircuitBreaker> = new Map();
  private readonly defaultConfig: CircuitBreakerConfig;
  private readonly logger?: Logger;

  /**
   * @param defaultConfig - Default circuit breaker configuration
   * @param logger - Optional logger
   */
  constructor(defaultConfig?: CircuitBreakerConfig, logger?: Logger) {
    this.defaultConfig = defaultConfig ?? DEFAULT_CIRCUIT_BREAKER_CONFIG;
    this.logger = logger;
  }

  /**
   * Get or create a circuit breaker for an agent.
   *
   * @param agentName - The agent name
   * @param config - Optional per-agent configuration override
   * @returns The circuit breaker instance
   */
  getOrCreate(agentName: string, config?: CircuitBreakerConfig): CircuitBreaker {
    const existing = this.breakers.get(agentName);
    if (existing) {
      return existing;
    }

    const breaker = new CircuitBreaker(config ?? this.defaultConfig, this.logger);
    this.breakers.set(agentName, breaker);
    return breaker;
  }

  /**
   * Get a circuit breaker for an agent if it exists.
   *
   * @param agentName - The agent name
   * @returns The circuit breaker, or undefined
   */
  get(agentName: string): CircuitBreaker | undefined {
    return this.breakers.get(agentName);
  }

  /**
   * Remove a circuit breaker.
   *
   * @param agentName - The agent name
   */
  remove(agentName: string): void {
    this.breakers.delete(agentName);
  }

  /**
   * Reset all circuit breakers to CLOSED state.
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Get snapshots of all circuit breakers for monitoring.
   */
  getAllSnapshots(): ReadonlyMap<string, CircuitBreakerSnapshot> {
    const snapshots = new Map<string, CircuitBreakerSnapshot>();
    for (const [name, breaker] of this.breakers) {
      snapshots.set(name, breaker.snapshot());
    }
    return snapshots;
  }

  /**
   * Get all registered agent names.
   */
  get agentNames(): ReadonlyArray<string> {
    return [...this.breakers.keys()];
  }
}
