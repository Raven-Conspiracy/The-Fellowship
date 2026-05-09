# Agent Graph Design Guide

> **Audience:** Engineers defining new agent graphs  
> **Prerequisites:** Familiarity with the orchestrator's core concepts
> (see `README.md` → Core Concepts)  
> **Status:** Living document  
> **Last Updated:** 2026-05

---

## Overview

An **Agent Graph** is a directed acyclic graph (DAG) where each node represents
a call to a Striveworks agent via Apollo. This guide walks through defining a
new graph, registering it, testing it, and deploying it.

---

## Quick Start: Define a New Graph

### Step 1: Identify the Agents

Before writing any code, list the agents your graph will call:

| Step | Agent Name | Input Needed | Output Produced |
|---|---|---|---|
| 1 | `classifier` | `incident_id`, `raw_text` | `category`, `confidence` |
| 2 | `analyzer` | `incident_id`, `classifier` output | `analysis`, `confidence` |
| 3 | `summarizer` | `analyzer` output | `summary` |
| 4 (conditional) | `escalator` | `analyzer` output | `escalation_ticket` |

Ensure all agents are registered in the agent registry YAML (see
`docs/apollo-bridge.md` for registry setup).

### Step 2: Add Agent Name Constants

In `aip-logic/register-graphs.ts`, add your agent names to the `AGENTS` constant:

```typescript
const AGENTS = {
  // ... existing agents
  MY_NEW_AGENT: "my-new-agent" as const,
} as const;
```

### Step 3: Define the Graph Configuration

Add a new exported `AgentGraphConfig` object:

```typescript
export const MY_NEW_GRAPH: AgentGraphConfig = {
  graphName: "my-new-graph" as GraphName,
  version: "0.1.0",
  description: "Description of what this graph does",
  nodes: [
    {
      id: "step-1",
      agentName: AGENTS.CLASSIFIER,
      dependsOn: [],                         // No dependencies → runs immediately
      inputMapping: ["incident_id", "raw_text"],
    },
    {
      id: "step-2",
      agentName: AGENTS.ANALYZER,
      dependsOn: ["step-1"],                 // Waits for step-1 to complete
      inputMapping: ["incident_id", "step-1"],
    },
    {
      id: "step-3",
      agentName: AGENTS.SUMMARIZER,
      dependsOn: ["step-1", "step-2"],       // Waits for BOTH predecessors
      inputMapping: ["step-1", "step-2"],
    },
    {
      id: "step-4-conditional",
      agentName: AGENTS.ESCALATOR,
      dependsOn: ["step-2"],
      condition: {                            // Optional: only runs if predicate is true
        type: "predicate",
        expression: "state['step-2'].confidence < 0.7",
      },
      inputMapping: ["step-2"],
    },
  ],
};
```

### Step 4: Register in the Catalog

Add your graph to the `ALL_GRAPHS` array:

```typescript
export const ALL_GRAPHS: AgentGraphConfig[] = [
  INCIDENT_TRIAGE_GRAPH,
  DATA_ENRICHMENT_GRAPH,
  REPORT_GENERATION_GRAPH,
  MY_NEW_GRAPH,  // ← Add here
];
```

### Step 5: Write Tests

Create a test file for your graph topology:

```typescript
// orchestrator/tests/unit/graph/my-new-graph.test.ts
import { describe, it, expect } from "vitest";
import { GraphBuilder } from "../../../src/graph/graph-builder.js";
import { MY_NEW_GRAPH } from "../../../../aip-logic/register-graphs.js";

describe("My New Graph", () => {
  it("should have no cycles", () => {
    const builder = new GraphBuilder(MY_NEW_GRAPH.graphName, mockLogger);
    for (const node of MY_NEW_GRAPH.nodes) {
      builder.node(node.id, node.agentName, {
        dependsOn: node.dependsOn,
        condition: node.condition,
      });
    }
    const graph = builder.build();
    const result = graph.validate();
    expect(result.isOk()).toBe(true);
  });

  it("should have the correct number of nodes", () => {
    expect(MY_NEW_GRAPH.nodes).toHaveLength(4);
  });
});
```

---

## Graph Topology Patterns

### Pattern 1: Linear (Sequential)

```
A → B → C → D
```

Every node depends on the previous one. Simple, predictable, no parallelism.

```typescript
nodes: [
  { id: "A", agentName: "...", dependsOn: [] },
  { id: "B", agentName: "...", dependsOn: ["A"] },
  { id: "C", agentName: "...", dependsOn: ["B"] },
  { id: "D", agentName: "...", dependsOn: ["C"] },
]
```

### Pattern 2: Fan-Out / Fan-In (Diamond)

```
         ┌──► B ──┐
    A ───┤         ├──► D
         └──► C ──┘
```

B and C execute in parallel after A. D waits for both.

```typescript
nodes: [
  { id: "A", agentName: "...", dependsOn: [] },
  { id: "B", agentName: "...", dependsOn: ["A"] },
  { id: "C", agentName: "...", dependsOn: ["A"] },
  { id: "D", agentName: "...", dependsOn: ["B", "C"] },
]
```

### Pattern 3: Conditional Branch

```
    A → B → C
         │
         └──► D (only if B.confidence < 0.7)
```

D runs only if the condition on B's output is met.

```typescript
nodes: [
  { id: "A", agentName: "...", dependsOn: [] },
  { id: "B", agentName: "...", dependsOn: ["A"] },
  { id: "C", agentName: "...", dependsOn: ["B"] },
  {
    id: "D",
    agentName: "...",
    dependsOn: ["B"],
    condition: {
      type: "predicate",
      expression: "state.B.confidence < 0.7",
    },
  },
]
```

### Pattern 4: Multi-Source Fan-In

```
    A ──┐
    B ──┼──► D
    C ──┘
```

A, B, and C all run in parallel. D runs after all three complete.

```typescript
nodes: [
  { id: "A", agentName: "...", dependsOn: [] },
  { id: "B", agentName: "...", dependsOn: [] },
  { id: "C", agentName: "...", dependsOn: [] },
  { id: "D", agentName: "...", dependsOn: ["A", "B", "C"] },
]
```

---

## Node Configuration Reference

### `AgentNodeConfig` Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Unique node identifier within the graph |
| `agentName` | `AgentName` | ✅ | Logical agent name (must exist in registry) |
| `dependsOn` | `string[]` | ✅ | Node IDs this node depends on. Empty array = no dependencies. |
| `inputMapping` | `string[]` | ❌ | Keys to extract from `GraphState` for the agent payload. If omitted, full state is forwarded. |
| `condition` | `Condition` | ❌ | Predicate that gates execution. If `undefined`, node always runs. |
| `retryPolicy` | `RetryPolicy` | ❌ | Per-node retry overrides. Falls back to agent endpoint defaults. |
| `timeoutMs` | `number` | ❌ | Per-node timeout override. Falls back to agent endpoint defaults. |
| `description` | `string` | ❌ | Human-readable description for documentation. |

### `Condition` Type

```typescript
type Condition = {
  type: "predicate";
  expression: string;  // JavaScript expression evaluated against state
};
```

The `expression` is evaluated in a sandboxed context where `state` is the
current `GraphStateSnapshot`. The expression must return a boolean.

Examples:
- `"state.analyze.confidence < 0.7"`
- `"state.classify.category === 'critical'"`
- `"state.merge.record_count > 0"`

### `RetryPolicy` Type

```typescript
type RetryPolicy = {
  maxAttempts: number;       // Maximum attempts (including initial)
  backoffBaseMs: number;     // Base delay for exponential backoff
  maxBackoffMs: number;      // Cap on backoff delay
};
```

---

## Best Practices

### 1. Keep Graphs Small and Focused
A graph with 2–6 nodes is ideal. If you find yourself with 10+ nodes, consider
splitting into multiple graphs that call each other (future: subgraph support).

### 2. Use Descriptive Node IDs
Node IDs are how you reference outputs in `inputMapping` and `dependsOn`.
Use self-documenting names: `classify`, `analyze`, `summarize`, not `node1`,
`node2`.

### 3. Explicit `inputMapping` Over Full State Forwarding
Specifying `inputMapping` makes the data flow explicit and prevents accidental
data leakage between agents. Only omit it during prototyping.

### 4. Test Graph Topology
Always write a test that validates:
- The graph is acyclic (cycle detection in `GraphBuilder`)
- All agent names exist in the registry
- The expected number of nodes is correct

### 5. Version Your Graphs
Use the `version` field for semantic versioning. When you change a graph's
topology, bump the version. This helps with debugging and rollback.

### 6. Document Conditions
Condition expressions are strings evaluated at runtime. Document what each
condition means in the `description` field of the node.

---

## Debugging a Graph

### Enable Debug Logging
Set `LOG_LEVEL=debug` to see every state transition, node start/complete, and
retry attempt.

### Use the Graph Visualizer (Future)
A future tool will convert a graph config to a Mermaid diagram for visual
inspection.

### Validate in Isolation
Use the `GraphBuilder` directly in a test to validate your graph topology
before deploying:

```typescript
const builder = new GraphBuilder("my-graph", logger);
builder.node("A", "agent-a", { dependsOn: [] });
builder.node("B", "agent-b", { dependsOn: ["A"] });
const graph = builder.build();
const result = graph.validate();
// result.isOk() → graph is valid
// result.isErr() → inspect result.error for details
```

---

## Graph Lifecycle

```
┌──────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐
│ DEFINED  │───►│REGISTERED│───►│ VALIDATED  │───►│ EXECUTED │
│ (code)   │    │ (startup)│    │ (topology) │    │ (runtime)│
└──────────┘    └──────────┘    └───────────┘    └──────────┘
                                                       │
                                                  ┌────▼────┐
                                                  │COMPLETED│
                                                  │(result) │
                                                  └─────────┘
```

1. **Defined** in `register-graphs.ts` as an `AgentGraphConfig`
2. **Registered** at startup via `registerAllGraphs(logger)`
3. **Validated** for cycles and agent existence
4. **Executed** when AIP Logic calls `triggerGraph()`
5. **Completed** with an `ExecutionResult`

---

## Further Reading

- `docs/architecture.md` — ADR-003 (immutable GraphState), ADR-005 (retry)
- `docs/apollo-bridge.md` — Agent registry setup
- `aip-logic/register-graphs.ts` — Reference implementations
- `orchestrator/tests/fixtures/graph-fixtures.ts` — Test graph examples
