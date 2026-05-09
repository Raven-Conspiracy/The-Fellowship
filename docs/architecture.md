# Architecture Decision Records

> **Project:** The Fellowship — Foundry × Striveworks Agent Orchestration Layer  
> **Status:** Living document  
> **Last Updated:** 2026-05

---

## ADR-001: TypeScript as Orchestration Language

### Status
✅ Accepted

### Context
The orchestration engine needs to run inside Foundry Code Workspaces, which
support TypeScript natively via their Function SDK. Python transforms run in a
separate runtime and cannot easily call into the orchestration engine.

The team evaluated two options:
1. **TypeScript** — Native Code Workspace support, single call boundary,
   async/await for IO-bound workloads.
2. **Python** — Familiar to the data engineering team, but requires a
   serialization boundary between AIP Logic (TypeScript) and the orchestrator.

### Decision
We will implement the orchestration engine in **TypeScript** (ESM, strict mode).

### Rationale
- **No serialization boundary**: AIP Logic stubs are TypeScript. Keeping the
  call boundary in the same language eliminates a JSON-serialize/deserialize
  hop on every graph trigger.
- **Async model**: TypeScript's `async`/`await` with `Promise.all` maps
  naturally to parallel node execution in a DAG.
- **Type system**: Branded types, discriminated unions, and strict null checks
  prevent entire classes of bugs at compile time.
- **Foundry SDK alignment**: Code Workspaces ship with TypeScript SDK support
  out of the box. No additional runtime to manage.

### Consequences
- The data engineering team must be comfortable reading TypeScript for code
  reviews of the orchestration layer.
- Python remains for data transforms (`transforms/python/`), which have their
  own isolated runtime.
- `"type": "module"` in `package.json` means all imports use `.js` extensions
  (ESM spec compliance).

---

## ADR-002: `neverthrow` for Result Types

### Status
✅ Accepted

### Context
The orchestration engine makes multiple IO-bound calls per graph execution
(Apollo HTTP, Foundry Ontology writes, Stream events). Each call can fail for
many reasons: network errors, auth failures, timeouts, upstream 5xx.

Traditional try/catch error handling leads to:
- Inconsistent error propagation (some errors are caught, some aren't)
- Lost type information (caught errors are `unknown`)
- Mixed control flow (some functions throw, others return error codes)

### Decision
All public-facing async functions return `Result<T, E>` from the `neverthrow`
library. Errors are never thrown across module boundaries.

### Rationale
- **Explicit error paths**: Callers must handle both `ok` and `err` branches.
  TypeScript enforces this via the `Result` type.
- **Typed errors**: `DomainError` is a base class with discriminated subtypes
  (`NetworkError`, `ApolloError`, `CircuitBreakerOpenError`, etc.). Callers
  can switch on `error.code` for precise handling.
- **Composability**: `Result.map`, `Result.andThen`, `Result.match` allow
  chaining operations without nested try/catch blocks.
- **No thrown exceptions**: Internal throws are caught and wrapped at module
  boundaries. Callers never see an unhandled promise rejection.

### Consequences
- Every function signature includes a `Result` type parameter. This adds
  verbosity but buys correctness.
- The team must agree on a consistent error code taxonomy (see `errors.ts`).
- `ResultAsync` is used for Promise-returning functions.

---

## ADR-003: Immutable `GraphState` with `set()` Returning New State

### Status
✅ Accepted

### Context
`GraphState` is the shared data bag that flows through a graph execution.
Multiple nodes may read from and write to this state. In a DAG with parallel
branches, two nodes could theoretically try to mutate the same key
simultaneously, leading to non-deterministic results.

### Decision
`GraphState` is **immutable**. The `set(key, value)` method returns a **new**
`GraphState` instance with the update applied. The original instance is
unchanged.

### Rationale
- **Deterministic execution**: Each node receives a consistent snapshot of
  state at the time it was scheduled. No other node can mutate it mid-flight.
- **Time-travel debugging**: Because state is immutable, we can replay a graph
  from any checkpoint by re-applying the same sequence of `set()` calls.
- **Safe parallelism**: `Promise.all` can fan out to multiple nodes without
  locks or synchronization primitives. Each node gets its own state reference.
- **Audit trail**: Every state transition is explicit. The `set()` call is
  logged, providing a complete mutation history.

### Consequences
- All state mutations go through the `GraphRunner`, which sequences writes.
  Direct mutation of `GraphState` is prevented by design (no public setters).
- Memory allocation increases slightly (new object per mutation), but state
  objects are small (keys → agent results, not large blobs).
- The `graph_context` block is injected by the adapter layer and is read-only
  from the agent's perspective.

---

## ADR-004: Branded Types for Domain Identifiers

### Status
✅ Accepted

### Context
The codebase has many string-typed identifiers: `AgentName`, `GraphId`,
`ExecutionId`, `NodeId`, `RequestId`. Passing a `GraphId` where an
`ExecutionId` is expected is a runtime bug that TypeScript's structural
typing will not catch (both are `string`).

### Decision
All domain identifiers use **branded types** — a TypeScript pattern that
creates nominal types from primitives:

```typescript
type AgentName = string & { readonly __brand: "AgentName" };
type GraphId = string & { readonly __brand: "GraphId" };
type ExecutionId = string & { readonly __brand: "ExecutionId" };
```

### Rationale
- **Compile-time safety**: Assigning a `GraphId` to an `ExecutionId` parameter
  is a type error.
- **Zero runtime cost**: Branded types are erased at compile time. They are
  plain `string` values at runtime.
- **Self-documenting**: Function signatures clearly communicate what kind of
  identifier is expected.

### Consequences
- Creating branded values requires explicit casting (e.g.,
  `"incident-triage" as GraphId`). Helper functions like `ulidFactory()`
  produce pre-branded ULIDs.
- The brand must be carried through serialization (JSON doesn't preserve
  brands). Deserialization must re-apply the brand.

---

## ADR-005: Per-Node Retry with Exponential Backoff

### Status
✅ Accepted

### Context
Striveworks agents accessed via Apollo are network-dependent services. Calls
can fail transiently due to network blips, timeouts, or upstream load. Retrying
at the graph level is too coarse — it would re-execute already-successful nodes.

### Decision
Retry is **per-node**, governed by a `RetryPolicy` that specifies:
- `maxAttempts`: Maximum number of attempts (including the initial call)
- `backoffBaseMs`: Base delay for exponential backoff
- `maxBackoffMs`: Cap on backoff delay

The backoff formula is: `min(base * 2^(attempt-1), maxBackoffMs) * random_jitter(0.5, 1.0)`

### Rationale
- **Granularity**: Only the failed node retries. Successful siblings are
  unaffected.
- **Jitter**: Prevents thundering-herd retries when multiple nodes hit the
  same upstream failure simultaneously.
- **Circuit breaker integration**: If the circuit breaker opens, retries
  are skipped entirely (fast-fail).

### Consequences
- Retry configuration can be set at three levels: agent endpoint defaults
  (YAML), graph node overrides, and individual call options. The most
  specific wins.
- Retries are logged at `WARN` level for observability.

---

## ADR-006: Circuit Breaker for Apollo Upstream Protection

### Status
✅ Accepted

### Context
If the Apollo service (or a specific Striveworks agent) becomes unhealthy,
repeated retries will compound the problem by adding load to an already
struggling service. This can cascade into resource exhaustion on the
orchestrator side (open connections, pending promises).

### Decision
A **circuit breaker** wraps the Apollo HTTP client with three states:
- **CLOSED**: Normal operation. Requests flow through.
- **OPEN**: Failure threshold exceeded. Requests are rejected immediately
  with `CircuitBreakerOpenError`.
- **HALF_OPEN**: After a reset timeout, a single probe request is allowed.
  Success → CLOSED; Failure → OPEN.

### Rationale
- **Fast-fail**: When the circuit is OPEN, graph execution fails quickly
  rather than waiting for timeouts.
- **Self-healing**: The HALF_OPEN state allows the system to test the
  upstream without manual intervention.
- **Standard pattern**: Circuit breakers are a well-understood resilience
  pattern (cf. Nygard, "Release It!").

### Consequences
- The circuit breaker state is exposed for monitoring (`getCircuitBreakerState()`).
- A manual `resetCircuitBreaker()` method is available for operational
  intervention.
- The failure threshold and reset timeout are configurable in the Apollo
  endpoint configuration.

---

## System Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            AIP LOGIC (Foundry)                            │
│                                                                           │
│  trigger-graph.ts ──► build ExecutionRequest ──► call executeGraph()     │
│                                                                           │
│  register-graphs.ts ──► define all known AgentGraphs at startup          │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATION ENGINE (this repo)                      │
│                                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ GraphBuilder │  │ GraphRunner  │  │ GraphState   │  │ AgentRegistry │ │
│  │              │  │              │  │              │  │               │ │
│  │ Fluent API   │  │ DAG exec     │  │ Immutable    │  │ Name→Endpoint │ │
│  │ Cycle detect │  │ Parallel/Seg │  │ Typed state  │  │ YAML-loaded   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘ │
│         │                 │                 │                   │         │
│         └─────────────────┼─────────────────┼───────────────────┘         │
│                           │                 │                             │
│                    ┌──────▼──────┐   ┌──────▼──────┐                      │
│                    │AgentExecutor│   │ RetryPolicy │                      │
│                    │             │   │              │                      │
│                    │ Per-node    │   │ Expo backoff│                      │
│                    │ invocation  │   │ + jitter    │                      │
│                    └──────┬──────┘   └─────────────┘                      │
│                           │                                               │
│  ┌────────────────────────┼────────────────────────────────────────────┐ │
│  │                 ADAPTER LAYER                                        │ │
│  │                                                                      │ │
│  │  ┌─────────────────▼──────────────┐  ┌──────────────────────────┐   │ │
│  │  │ ApolloAdapter                  │  │ FoundryAdapter            │   │ │
│  │  │                                │  │                           │   │ │
│  │  │ AgentNode → ApolloRequest      │  │ OntologyWriter            │   │ │
│  │  │ ApolloResponse → AgentResult   │  │ EventEmitter              │   │ │
│  │  └───────────────┬────────────────┘  └────────────┬─────────────┘   │ │
│  │                  │                                │                  │ │
│  │  ┌───────────────▼────────────────┐  ┌────────────▼─────────────┐   │ │
│  │  │ ApolloClient                   │  │ Foundry HTTP (axios)      │   │ │
│  │  │                                │  │                           │   │ │
│  │  │ axios + axios-retry            │  │ Ontology Action Types     │   │ │
│  │  │ CircuitBreaker                 │  │ Streams Events            │   │ │
│  │  │ Auth header injection          │  │ Auth header injection     │   │ │
│  │  └────────────────────────────────┘  └──────────────────────────┘   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         PALANTIR APOLLO                                   │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │              Service Mesh / Deployment Bridge                      │    │
│  │                                                                    │    │
│  │   /striveworks/classify    /striveworks/analyze    ...             │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      STRIVEWORKS CHARIOT                                  │
│                                                                           │
│   Agent: Classifier    Agent: Analyzer    Agent: Summarizer    ...        │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: Single Node Execution

```
   AgentExecutor.execute(node, state)
          │
          ▼
   AgentRegistry.get(node.agentName)
          │
          ▼ ok(endpoint)
   ApolloAdapter.executeNode(node, state)
          │
          ├─► buildRequest(node, state) → ApolloRequest
          │        │
          │        └─► resolvePayload(config, state)
          │               ├─ inputMapping? → extract keys from state
          │               └─ no mapping?   → forward full state
          │
          ▼ ApolloRequest
   ApolloClient.execute(request)
          │
          ├─► CircuitBreaker.isOpen()? → reject immediately
          │
          ├─► axios.post(route, payload)  [with retry]
          │        │
          │        ├─ OK ──► breaker.recordSuccess()
          │        │
          │        └─ ERR ─► breaker.recordFailure()
          │                  ├─ retryable? → backoff → retry
          │                  └─ non-retryable? → return err
          │
          ▼ ok(ApolloResponse)
   ApolloAdapter.mapResponse(response, node) → AgentResult
          │
          ▼ ok(AgentResult)
   AgentExecutor attaches timing metadata
          │
          ▼ ok(AgentResult)
   GraphRunner writes result into GraphState
```

---

## Error Handling Strategy

```
                           DomainError (abstract)
                                  │
          ┌───────────────────────┼───────────────────────────┐
          │                       │                           │
   NetworkError            ApolloError                FoundryError
   (retryable)             (may be retryable)         (context-dependent)
          │                 │         │                    │
   TimeoutError    AuthenticationError  │          FoundryWriteError
   (retryable)     (non-retryable)     │          FoundryAuthError
                                       │          FoundryStreamError
                                ApolloAdapterError
                                (non-retryable)

   CircuitBreakerOpenError ─── retryable (may have recovered)
   AgentRegistryError ─────── non-retryable
   AgentExecutionError ────── non-retryable (wrapper after retries exhausted)
   GraphValidationError ───── non-retryable
   GraphCycleError ────────── non-retryable
```

**Rule of thumb:**
- Network blips and timeouts → retryable
- Bad credentials or bad payloads → non-retryable (retrying won't help)
- Circuit breaker open → retryable (might be half-open soon)
- Exhausted retries → wrapped in `AgentExecutionError` (non-retryable)

---

## Deployment Architecture

```
Foundry Code Workspace
├── AIP Logic Function (thin wrapper)
│   └── triggerGraph("incident-triage", input)
│
├── Orchestration Engine (this repo, compiled TS → JS)
│   ├── node_modules/ (neverthrow, axios, pino, zod, ulid, yaml)
│   └── dist/
│       ├── core/
│       ├── graph/
│       ├── agents/
│       ├── adapters/
│       └── index.js
│
└── Python Transforms (separate venv, deployed as Foundry Python transforms)
    └── transforms/python/
        ├── ingest/
        └── output/
```

### Environment Configuration
- **dev**: `configs/dev.yaml` — dev Apollo endpoints, debug logging, disabled circuit breaker
- **staging**: `configs/staging.yaml` — staging Apollo, info logging, enabled circuit breaker
- **prod**: `configs/prod.yaml` — production Apollo, warn logging, circuit breaker with tight thresholds

Configs are loaded based on `ORCHESTRATION_ENV` (falls back to `NODE_ENV`).
