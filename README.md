# The-Fellowship
# Foundry × Striveworks — Agent Orchestration Layer

> **Status:** 🟡 Active Planning / Early Scaffolding  
> **Languages:** TypeScript (orchestration engine) · Python (Foundry transforms)  
> **Owner:** [Gandolf]  
> **Last Updated:** 2026-05  
> **Target Scale:** ~5,000 concurrent users  
> **Design Mandate:** Lean — minimize compute footprint, token usage, and dependencies

---

## The Problem We're Solving

Striveworks brings the agents. Foundry provides the data platform. The gap is
**how those agents are coordinated at runtime**.

Currently, agents are invoked one at a time inside **Palantir AIP Logic**.
AIP Logic is a solid workflow builder — it handles scheduling, Ontology I/O,
and lineage. What it is not is an agent orchestration system. It lacks:

- Multi-agent graphs (parallel, conditional, fan-out / fan-in)
- Agent-to-agent state passing without writing back to the Ontology between every step
- Retry strategies, circuit breaking, and fallback routing at the agent level
- Dynamic execution plans (graph shape changes based on runtime data)
- Human-in-the-loop checkpoints mid-graph without a full workflow restart
- Durable execution (pause, resume, replay from a checkpoint)

**This orchestration layer replaces AIP Logic for agent coordination.**
AIP Logic is not the entry point — the orchestrator is triggered directly
by Foundry Ontology events, schedules, or Functions. It owns the full
agent execution lifecycle end-to-end, then writes results directly back
to the Ontology. We eliminate the AIP Logic middleman to reduce latency,
compute overhead, and token consumption at scale (~5,000 users).

---

## Scope: What This Repo Is and Is Not

| In scope | Out of scope |
|---|---|
| Agent graph definition (what runs, when, in what order) | AI model development or fine-tuning |
| Execution engine (run graphs, manage state, handle failures) | Striveworks Chariot internal configuration |
| Apollo bridge (how we invoke Striveworks agents from Foundry) | Foundry Ontology data modeling |
| Direct Ontology read/write (no AIP Logic middleman) | Training pipelines |
| Result emission back to Foundry Ontology | End-user UI / AIP Agent Studio |
| Observability (trace every agent hop) | MLOps / drift monitoring |

**Striveworks owns the agents and their AI.  
Apollo owns the transport between Striveworks and Foundry.  
This repo owns the orchestration logic that drives those agents — and replaces AIP Logic for this purpose.**

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        PALANTIR FOUNDRY                              │
│                                                                       │
│   Ontology            Foundry Functions           Foundry Streams    │
│   (data model)        (trigger + deploy target)   (event bus)       │
│        │                     │                         ▲             │
│        │              triggers│                         │events       │
└────────┼─────────────────────┼─────────────────────────┼────────────┘
         │                     │                         │
         │         ┌───────────▼─────────────────────────┴───────────┐
         │         │         ORCHESTRATION LAYER  (this repo)        │
         │         │    (deploys as a Foundry Function /             │
         │         │     Code Workspace — replaces AIP Logic)        │
         │         │                                                  │
         │         │   Graph Engine (TypeScript)                      │
         │         │   ├── AgentGraph  (DAG / state machine)          │
         │         │   ├── GraphRunner (executes nodes, manages state)│
         │         │   ├── AgentRegistry (name → Apollo endpoint map) │
         │         │   └── Adapters                                   │
         │         │       ├── ApolloAdapter  (calls Striveworks)     │
         │         │       └── FoundryAdapter (reads/writes Ontology) │
         │         └────────────────────────┬────────────────────────┘
         │                                  │  via Apollo
┌────────┼──────────────────────────────────▼────────────────────────┐
│        │              PALANTIR APOLLO                               │
│        │         (deployment bridge / service mesh)                 │
│        │                     │                                      │
└────────┼─────────────────────┼──────────────────────────────────────┘
         │                     │
┌────────▼─────────────────────▼──────────────────────────────────────┐
│                     STRIVEWORKS CHARIOT                              │
│                                                                      │
│    Agent A          Agent B          Agent C          Agent N        │
│  (pre-built,      (pre-built,      (pre-built,      (pre-built,     │
│   AI-powered)      AI-powered)      AI-powered)      AI-powered)    │
└──────────────────────────────────────────────────────────────────────┘
```

### Request Flow (happy path)

```
1. Foundry Ontology event / schedule / user action
       ↓
2. Foundry Function triggers the orchestrator directly (no AIP Logic)
       ↓
3. Orchestrator resolves ExecutionRequest from Ontology context
       ↓
4. GraphRunner loads the named AgentGraph, resolves the execution plan
       ↓
5. Each AgentNode is executed in order (sequential / parallel per graph)
   — ApolloAdapter calls the Striveworks agent via Palantir Apollo
   — Agent result is written into the shared GraphState
       ↓
6. Final GraphState is mapped to a Foundry-typed result
       ↓
7. FoundryAdapter writes result directly back to the Ontology via Action Type
   (no AIP Logic handoff — one less hop, one less serialization boundary)
```

---

## Why TypeScript for the Orchestration Engine

- **Foundry Functions** run TypeScript natively (v1 and v2 runtimes) with
  first-class Ontology SDK support — this is the lowest-friction deployment target.
- The orchestration engine is IO-bound and event-driven; TypeScript's async
  model (async/await + Promise composition) is a natural fit.
- **Lean by design:** TypeScript + the Ontology SDK lets us read/write the
  Ontology directly without serialization hops through AIP Logic. Fewer
  moving parts = lower compute and token usage at 5,000-user scale.
- Python remains for **Python Transforms** (data pipeline work), which have
  their own runtime and handle heavy ETL/embedding workloads separately.

---

## Repository Layout

```
foundry-striveworks-orchestration/
│
├── README.md                          ← You are here
│
├── docs/
│   ├── architecture.md                ← ADRs and deep-dive diagrams
│   ├── aip-logic-vs-orchestration.md  ← Why we need this layer (team explainer)
│   ├── agent-graph-design.md          ← How to define and register a graph
│   ├── apollo-bridge.md               ← Apollo integration details
│   └── runbook.md                     ← Ops: deploy, debug, rollback
│
├── orchestrator/                      ← TypeScript: orchestration engine
│   ├── src/
│   │   ├── core/
│   │   │   ├── types.ts               ← All shared types / contracts
│   │   │   ├── errors.ts              ← Typed error hierarchy
│   │   │   └── logger.ts              ← Structured JSON logging
│   │   │
│   │   ├── graph/
│   │   │   ├── agent-graph.ts         ← AgentGraph class (DAG definition)
│   │   │   ├── agent-node.ts          ← AgentNode (a single agent call)
│   │   │   ├── graph-state.ts         ← Mutable execution state (typed)
│   │   │   ├── graph-builder.ts       ← Fluent builder API for graph definitions
│   │   │   └── graph-runner.ts        ← Executes a graph against real agents
│   │   │
│   │   ├── agents/
│   │   │   ├── agent-registry.ts      ← Maps agent names → Apollo endpoint config
│   │   │   └── agent-executor.ts      ← Calls one Striveworks agent via Apollo
│   │   │
│   │   ├── adapters/
│   │   │   ├── apollo/
│   │   │   │   ├── apollo-client.ts   ← Authenticated Apollo HTTP client
│   │   │   │   └── apollo-adapter.ts  ← Translates AgentNode → Apollo request
│   │   │   └── foundry/
│   │   │       ├── ontology-writer.ts ← Writes AgentGraph results to Ontology
│   │   │       └── event-emitter.ts   ← Publishes graph events to Foundry Streams
│   │   │
│   │   └── index.ts                   ← Public API surface (what AIP Logic imports)
│   │
│   ├── tests/
│   │   ├── unit/
│   │   │   ├── graph/                 ← Graph building, state, DAG validation
│   │   │   ├── agents/                ← Agent registry, executor (mocked Apollo)
│   │   │   └── adapters/              ← Apollo client, Foundry writer (mocked)
│   │   └── integration/               ← End-to-end with live Apollo dev instance
│   │
│   ├── package.json
│   └── tsconfig.json
│
├── aip-logic/                         ← AIP Logic function stubs (TypeScript)
│   ├── trigger-graph.ts               ← Entry point: AIP Logic calls this
│   └── register-graphs.ts             ← Registers all known AgentGraphs
│
├── transforms/                        ← Python: Foundry-native data transforms
│   └── python/
│       ├── core/
│       │   ├── config.py              ← Transform-level settings
│       │   └── logging.py             ← Structured logging for transforms
│       ├── ingest/
│       │   └── raw_to_ontology.py     ← Source data → Ontology objects
│       └── output/
│           └── results_to_dataset.py  ← Orchestration results → Foundry dataset
│
├── configs/
│   ├── dev.yaml                       ← Dev environment (Apollo endpoints, etc.)
│   ├── staging.yaml
│   └── prod.yaml
│
└── .env.example                       ← Required environment variables
```

---

## Core Concepts

### AgentGraph

An `AgentGraph` is a directed graph where each **node** is a Striveworks agent
call and each **edge** is a conditional or unconditional transition.

```typescript
const triage = new GraphBuilder("incident-triage")
  .node("classify",  agents.CLASSIFIER)
  .node("analyze",   agents.ANALYZER,  { dependsOn: ["classify"] })
  .node("summarize", agents.SUMMARIZER, { dependsOn: ["analyze"] })
  .node("escalate",  agents.ESCALATOR, {
    dependsOn: ["analyze"],
    condition: (state) => state.get("analyze").confidence < 0.7,
  })
  .build();
```

Nodes with no `dependsOn` run immediately (in parallel if there are multiple).
Nodes with `dependsOn` wait for all listed predecessors to complete.
`condition` gates control whether a node runs at all.

### GraphState

`GraphState` is the shared, typed bag of data that flows through the graph.
Each node reads from it and writes its output into it. Nodes are never directly
aware of each other — they communicate only through state.

```
Input Payload → GraphState (initial) → [Node A writes] → [Node B reads A's output]
                                                        → [Node C reads A's output]
→ Final GraphState → mapped to Foundry result
```

### AgentRegistry

Maps logical agent names to their Apollo endpoint configuration. This is the
only place that knows "agent CLASSIFIER lives at Apollo route X with payload
schema Y". Swapping an agent's endpoint does not touch graph definitions.

### ApolloAdapter

Translates an `AgentNode` execution request into an Apollo API call and maps
the Apollo response back to a typed `AgentResult`. Apollo is the transport;
this adapter is the only component that knows Apollo's wire format.

---

## AIP Logic vs. This Orchestrator

This is the most important concept for the team to internalize.

| | AIP Logic | This Orchestrator |
|---|---|---|
| **Role** | Entry/exit point, Ontology I/O, scheduling | Agent coordination runtime |
| **What it sees** | "Run graph X with input Y, give me result Z" | All of the in-between |
| **Multi-agent** | Sequential function calls only | DAG: parallel, conditional, fan-out |
| **State between agents** | Must round-trip through Ontology | In-memory GraphState (fast, typed) |
| **Failure handling** | Workflow-level retry | Per-node retry, circuit breaker, fallback |
| **Human checkpoint** | Requires new workflow trigger | Pause/resume at any node boundary |
| **Visibility** | AIP Logic audit trail | Per-hop trace + Foundry Streams events |

**AIP Logic does not go away.** It triggers this layer and receives the final
result. The team writes AIP Logic stubs that are thin — build the request,
call the orchestrator, write the result. All coordination logic lives here.

---

## Team To-Do List

### Phase 0 — Foundation & Alignment (Week 1–2)

**Architecture**
- [ ] Confirm Apollo endpoint pattern for invoking Striveworks agents
- [ ] Confirm which Striveworks agents exist and their I/O schemas
- [ ] Confirm Foundry Code Workspace setup (TypeScript SDK version)
- [ ] Confirm Apollo auth mechanism (token type, scope, rotation)
- [ ] Document first target graph (which agents, what sequence, what triggers it)

**Scaffolding**
- [ ] Set up `orchestrator/` TypeScript project (`package.json`, `tsconfig.json`)
- [ ] Set up `transforms/python/` with `pyproject.toml`
- [ ] Establish CI pipeline (lint, type-check, unit tests on PR)
- [ ] Stand up `configs/dev.yaml` with Apollo endpoints for dev Striveworks environment

### Phase 1 — Single Linear Graph (Week 3–5)
- [ ] Implement `core/types.ts` — `AgentGraph`, `AgentNode`, `GraphState`, `AgentResult`
- [ ] Implement `core/errors.ts` — typed error hierarchy
- [ ] Implement `adapters/apollo/apollo-client.ts` — auth + retry + error mapping
- [ ] Implement `adapters/apollo/apollo-adapter.ts` — `AgentNode` → Apollo wire call
- [ ] Implement `agents/agent-registry.ts` — register first set of Striveworks agents
- [ ] Implement `agents/agent-executor.ts` — execute one node via Apollo
- [ ] Implement `graph/graph-state.ts` — typed state container
- [ ] Implement `graph/graph-runner.ts` — sequential graph execution (no parallelism yet)
- [ ] Implement `graph/graph-builder.ts` — fluent graph definition API
- [ ] Write `aip-logic/trigger-graph.ts` — AIP Logic entry point for first graph
- [ ] **Demo:** AIP Logic triggers a 2-agent linear graph, result writes to Ontology
- [ ] Unit tests ≥ 80% coverage on all above

### Phase 2 — Full DAG Execution (Week 6–8)
- [ ] Add parallel node execution to `graph-runner.ts` (Promise.all for independent nodes)
- [ ] Add conditional edges (`condition` predicate on `AgentNode`)
- [ ] Add per-node retry config (max attempts, backoff strategy)
- [ ] Add circuit breaker to `apollo-client.ts`
- [ ] Implement `adapters/foundry/event-emitter.ts` — emit per-hop events to Foundry Streams
- [ ] Implement `adapters/foundry/ontology-writer.ts` — write final result to Ontology
- [ ] Add human-in-the-loop pause (node signals "waiting for approval" → Foundry action type)
- [ ] Integration tests against dev Apollo/Striveworks environment
- [ ] **Demo:** 4-agent graph with parallel branches and one conditional node

### Phase 3 — Hardening & Production (Week 9–12)
- [ ] Durable execution: serialize `GraphState` to Foundry dataset on each node completion
  (enables replay from last checkpoint if the Code Workspace is interrupted)
- [ ] Full end-to-end trace: every node hop visible in Foundry audit trail
- [ ] Load test: target graph at expected production volume
- [ ] Security review: no agent payload contains raw Ontology markings; auth token rotation
- [ ] Write `docs/runbook.md` — deploy, rollback, on-call playbook
- [ ] Apollo production endpoint configuration (prod config, Apollo-managed secrets)
- [ ] Promote to staging → prod via Apollo

### Ongoing
- [ ] New Striveworks agent? Register it in `agent-registry.ts`, write a node test
- [ ] New use-case graph? Use `GraphBuilder`, register in `register-graphs.ts`
- [ ] Unit tests must pass on every PR; integration tests on merge to `main`

---

## Open Decisions

| Decision | Options | Owner | Due |
|---|---|---|---|
| Apollo auth mechanism | API key vs mTLS vs Apollo-managed identity | TBD | Phase 0 |
| GraphState persistence | In-memory only (Phase 1) vs Foundry dataset checkpoint | TBD | Phase 3 |
| AIP Logic call pattern | Synchronous function call vs async + polling | TBD | Phase 1 |
| Parallel execution model | Promise.all vs worker pool vs Foundry job queue | TBD | Phase 2 |
| Human checkpoint UX | AIP Agent Studio action vs custom Slate app | TBD | Phase 2 |
| Error surface to AIP Logic | Typed error codes vs structured JSON error body | TBD | Phase 1 |

---

## Environment Variables

See `.env.example` for the full list. Minimum to get started in dev:

```bash
# Apollo (bridge to Striveworks)
APOLLO_BASE_URL=https://your-apollo-instance.palantirfoundry.com
APOLLO_TOKEN=...                   # Dev token — Apollo-managed in prod

# Striveworks agents (registered in agent-registry.ts)
STRIVEWORKS_ENV=dev                # dev | staging | prod

# Foundry
FOUNDRY_URL=https://your-enrollment.palantirfoundry.com
FOUNDRY_TOKEN=...                  # Service token

# Orchestration runtime
ORCHESTRATION_ENV=dev
GRAPH_STATE_PERSIST=false          # true in Phase 3 (writes checkpoint to Foundry dataset)
LOG_LEVEL=info                     # debug | info | warn | error
STRUCTURED_LOGGING=false           # true in staging/prod
```

---

## Local Development

```bash
# 1. Clone
git clone <repo>
cd foundry-striveworks-orchestration

# 2. TypeScript orchestrator
cd orchestrator
npm install
npm run typecheck
npm test              # unit tests only (no external calls)

# 3. Python transforms (separate venv)
cd ../transforms/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest

# 4. Integration tests (requires Apollo dev access)
cd ../../orchestrator
ORCHESTRATION_ENV=dev npm run test:integration
```

---

## Glossary

| Term | Meaning |
|---|---|
| **Striveworks / Chariot** | The MLOps platform that hosts and serves the AI agents |
| **Agent** | A Striveworks-built, AI-powered callable unit (not a generic "agent") |
| **Apollo** | Palantir's deployment and service mesh platform; the transport between Foundry and Striveworks |
| **AIP Logic** | Foundry's low/pro-code function builder — our entry and exit point, not the orchestration runtime |
| **AgentGraph** | A directed graph (DAG) of agent nodes and their execution dependencies |
| **AgentNode** | A single vertex in an `AgentGraph` — maps to one Striveworks agent call |
| **GraphState** | The shared typed state bag that flows through a graph execution |
| **GraphRunner** | The engine that walks a graph, executes nodes, and manages state |
| **AgentRegistry** | The map of logical agent names to their Apollo endpoint config |
| **ApolloAdapter** | The anti-corruption layer between our types and Apollo's wire format |
| **FoundryAdapter** | Writes final graph results back to the Foundry Ontology |
| **ExecutionRequest** | What AIP Logic sends to the orchestrator: graph name + input payload |

---

## References

- [Palantir AIP Architecture](https://www.palantir.com/docs/foundry/architecture-center/aip-architecture)
- [AIP Logic Documentation](https://www.palantir.com/docs/foundry/aip/overview)
- [Palantir Apollo](https://www.palantir.com/docs/apollo/overview)
- [Striveworks Chariot User Guide](https://production.chariot.striveworks.us/docs/user_guide/)
- Internal: `docs/aip-logic-vs-orchestration.md` — full rationale (share with stakeholders)
- Internal: `docs/agent-graph-design.md` — how to define and register a new graph
- Internal: `docs/apollo-bridge.md` — Apollo integration details and auth setup
