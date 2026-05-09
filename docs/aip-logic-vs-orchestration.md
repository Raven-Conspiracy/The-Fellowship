# AIP Logic vs. The Orchestration Layer

> **Audience:** Engineering team, stakeholders, and anyone asking "why do we
> need another layer?"  
> **Status:** Living document  
> **Last Updated:** 2026-05

---

## The Elevator Pitch

**AIP Logic** is the *entry and exit point*. It triggers work and receives
results. It handles Foundry-native concerns: Ontology I/O, scheduling,
lineage, and the Foundry audit trail.

**The Orchestration Layer** (this repo) is the *coordination runtime*. It
takes a graph definition, executes its nodes in the right order (including
parallel branches and conditional gates), retries failures, manages state
between nodes, and emits observability events.

AIP Logic does not go away. It calls this layer the same way it calls any
other function. The difference is that instead of calling one agent at a
time and writing intermediate results back to the Ontology, AIP Logic makes
*one call* and gets back the *final result*.

---

## Side-by-Side Comparison

| Concern | AIP Logic | Orchestration Layer |
|---|---|---|
| **Role** | Workflow entry/exit, Ontology I/O, scheduling | Multi-agent coordination runtime |
| **What it sees** | "Run graph X with input Y → result Z" | Every node, every state transition, every retry |
| **Multi-agent** | Sequential function calls only | DAG: parallel branches, fan-out/fan-in, conditions |
| **State between agents** | Must round-trip through Ontology (read → write) | In-memory `GraphState` — fast, typed, zero-copy |
| **Failure handling** | Workflow-level retry (all or nothing) | Per-node retry with exponential backoff, circuit breaker, fallback routing |
| **Human-in-the-loop** | Requires new workflow trigger / separate function | Pause/resume at any node boundary within the same execution |
| **Observability** | AIP Logic audit trail (start/end only) | Per-hop traces: `node.started`, `node.completed`, `node.error`, `node.skipped` |
| **Execution model** | Synchronous (one function call = one agent) | Async DAG with `Promise.all` for parallel branches |
| **Configuration** | Function-level parameters | Graph topology + per-node retry + agent endpoint registry |

---

## A Concrete Example: Incident Triage

### Without the Orchestration Layer (Current State)

```
AIP Logic Function: "Triage Incident"
   │
   ├─► Call Classifier agent via Apollo
   │      └─► Write result to Ontology (classifier_output object)
   │
   ├─► Read classifier_output from Ontology
   ├─► Call Analyzer agent via Apollo
   │      └─► Write result to Ontology (analyzer_output object)
   │
   ├─► Read analyzer_output from Ontology
   ├─► Call Summarizer agent via Apollo
   │      └─► Write result to Ontology (summarizer_output object)
   │
   ├─► Read analyzer_output from Ontology
   ├─► If confidence < 0.7:
   │      └─► Call Escalator agent via Apollo
   │             └─► Write result to Ontology (escalation_output object)
   │
   └─► Return final result to caller
```

**Problems:**
- 4+ Ontology reads/writes (each a network call, each creating an Ontology object)
- Manual state management between calls
- No retry logic except at the workflow level
- Adding a new step means editing AIP Logic code
- No observability into individual agent hops

### With the Orchestration Layer (Target State)

```
AIP Logic Function: "Triage Incident"
   │
   └─► triggerGraph("incident-triage", { incident_id, raw_text })
          │
          └─► Orchestration Layer handles EVERYTHING below:
                 │
                 ├─► classify (agent call)
                 │      └─► state.set("classify", result)
                 │
                 ├─► analyze (agent call, depends on classify)
                 │      └─► state.set("analyze", result)
                 │
                 ├─► summarize (agent call, depends on analyze)
                 │      └─► state.set("summarize", result)
                 │
                 └─► escalate (CONDITIONAL: if analyze.confidence < 0.7)
                        └─► state.set("escalate", result)
                 │
                 └─► return ExecutionResult
```

**Benefits:**
- **One** AIP Logic call — no intermediate Ontology objects
- State flows between agents in memory (microseconds, not milliseconds)
- Per-node retry with exponential backoff (configurable per agent)
- Circuit breaker prevents cascading failures
- Full observability: every node start/complete/error is emitted
- Adding a node = editing the graph definition, not AIP Logic code

---

## Why Not Put Everything in AIP Logic?

AIP Logic is excellent at:
- Responding to Ontology events ("when an Object Set changes, run this")
- Scheduling ("run this function every hour")
- Simple sequential workflows ("step 1 → step 2 → step 3")
- Managing Foundry permissions and data lineage

AIP Logic is not designed for:
- Parallel execution (`Promise.all`-style fan-out)
- Conditional branching based on runtime agent output
- Per-step retry with backoff strategies
- Circuit breaking an unhealthy downstream
- In-memory state sharing between steps (without Ontology round-trips)
- Durable pause/resume mid-execution

The orchestration layer fills these gaps without replacing AIP Logic. Think
of it as a specialized library that AIP Logic imports, like any other npm
package, to get advanced coordination capabilities.

---

## The Call Boundary

```
┌─────────────────────────────────────────────────────────┐
│                    AIP Logic Function                     │
│                                                          │
│  import { triggerGraph } from "./aip-logic/trigger-graph";│
│                                                          │
│  export async function myAipFunction(input: Input) {     │
│    const result = await triggerGraph(                    │
│      "incident-triage",                                  │
│      { incident_id: input.rid, raw_text: input.text }    │
│    );                                                    │
│                                                          │
│    if (result.isErr()) {                                 │
│      // Handle failure: log, retry, notify, etc.         │
│      throw new Error(result.error.message);              │
│    }                                                     │
│                                                          │
│    // Write final result to Ontology if needed            │
│    await writeToOntology(result.value.finalState);       │
│                                                          │
│    return result.value;                                  │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
```

The AIP Logic function remains the **owner** of the Ontology write. The
orchestration layer can write results for observability (optional, Phase 2+),
but the authoritative Ontology object is created by AIP Logic.

---

## When Does Each Layer Own What?

| Scenario | Owned by AIP Logic | Owned by Orchestration |
|---|---|---|
| Deciding *when* to run (schedule, event) | ✅ | |
| Defining *what agents* run | | ✅ (graph definition) |
| Defining *execution order* | | ✅ (graph topology) |
| Calling individual agents | | ✅ (AgentExecutor) |
| Retrying a failed agent call | | ✅ (RetryPolicy) |
| Deciding whether to skip a node | | ✅ (condition predicate) |
| Writing final result to Ontology | ✅ | (optional, for audit) |
| Emitting per-hop events | | ✅ (EventEmitter) |
| Handling a graph-level failure | ✅ (decide next step) | (returns typed error) |
| Human approval mid-graph | ✅ (AIP Agent Studio) | (pauses & resumes) |

---

## FAQ

### Q: Does the orchestration layer write to the Ontology?
**A:** It *can* (Phase 2+), but the authoritative write is done by AIP Logic.
The orchestrator writes events to Foundry Streams for observability and
optionally writes checkpoints for durable execution (Phase 3). The "source of
truth" Ontology object is always created by the AIP Logic function.

### Q: What if the Code Workspace restarts mid-graph?
**A:** In Phase 1, the graph is lost and must be re-triggered. In Phase 3,
durable execution checkpoints allow the graph to resume from the last
completed node. The orchestrator serializes `GraphState` to a Foundry dataset
after each node completes.

### Q: Can I call the orchestrator directly without AIP Logic?
**A:** Yes, for testing and debugging. The `triggerGraph()` function is
importable from any TypeScript environment. In production, the intended
pattern is AIP Logic → orchestrator.

### Q: How do I add a new agent to an existing graph?
**A:** Edit the graph definition in `aip-logic/register-graphs.ts`, add the
agent to the registry YAML, and write a test. See `docs/agent-graph-design.md`
for the full guide.

### Q: What happens if Apollo is down?
**A:** The circuit breaker opens after the configured failure threshold. Graph
execution fails immediately with a `CircuitBreakerOpenError`. AIP Logic can
decide to re-trigger the graph later or notify an operator.

---

## Further Reading

- `docs/architecture.md` — Full ADRs and system design
- `docs/agent-graph-design.md` — How to define and register a new graph
- `docs/apollo-bridge.md` — Apollo integration details
- `docs/runbook.md` — Operational procedures
