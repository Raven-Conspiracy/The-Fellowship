/**
 * Graph Fixtures
 *
 * Pre-built test `AgentGraphConfig` objects for unit and integration tests.
 * Each fixture represents a common graph topology pattern.
 *
 * Available fixtures:
 * - `LINEAR_2_NODE` — Simple A → B
 * - `LINEAR_3_NODE` — A → B → C
 * - `DIAMOND_4_NODE` — A → (B, C) → D
 * - `CONDITIONAL_GRAPH` — A → B, with conditional C
 * - `FAN_OUT_GRAPH` — A → (B, C, D) all in parallel
 * - `SINGLE_NODE` — Just one node
 */

import type {
  AgentGraphConfig,
  GraphName,
  AgentNodeConfig,
  Condition,
} from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function nc(
  id: string,
  agentName: string,
  dependsOn: string[] = [],
  opts?: { condition?: Condition; inputMapping?: string[] },
): AgentNodeConfig {
  return {
    id: id as any,
    agentName: agentName as any,
    dependsOn,
    inputMapping: opts?.inputMapping,
    condition: opts?.condition,
  };
}

// ---------------------------------------------------------------------------
// Single Node
// ---------------------------------------------------------------------------

/**
 * Single-node graph (trivial case).
 *
 * ```
 * A
 * ```
 */
export const SINGLE_NODE: AgentGraphConfig = {
  graphName: "single-node" as GraphName,
  version: "1.0.0",
  description: "Single node graph — simplest possible",
  nodes: [nc("a", "agent-a")],
};

// ---------------------------------------------------------------------------
// Linear Graphs
// ---------------------------------------------------------------------------

/**
 * Linear 2-node graph.
 *
 * ```
 * A → B
 * ```
 */
export const LINEAR_2_NODE: AgentGraphConfig = {
  graphName: "linear-2" as GraphName,
  version: "1.0.0",
  description: "Linear 2-node graph: A → B",
  nodes: [
    nc("a", "agent-a"),
    nc("b", "agent-b", ["a"]),
  ],
};

/**
 * Linear 3-node graph.
 *
 * ```
 * A → B → C
 * ```
 */
export const LINEAR_3_NODE: AgentGraphConfig = {
  graphName: "linear-3" as GraphName,
  version: "1.0.0",
  description: "Linear 3-node graph: A → B → C",
  nodes: [
    nc("a", "agent-a"),
    nc("b", "agent-b", ["a"]),
    nc("c", "agent-c", ["b"]),
  ],
};

// ---------------------------------------------------------------------------
// Diamond Graph (Fan-Out / Fan-In)
// ---------------------------------------------------------------------------

/**
 * Diamond 4-node graph: A → (B, C) → D
 *
 * ```
 *         ┌──► B ──┐
 *    A ───┤         ├──► D
 *         └──► C ──┘
 * ```
 *
 * B and C execute in parallel after A. D executes after both B and C.
 */
export const DIAMOND_4_NODE: AgentGraphConfig = {
  graphName: "diamond-4" as GraphName,
  version: "1.0.0",
  description: "Diamond graph: A → (B, C in parallel) → D",
  nodes: [
    nc("a", "agent-a"),
    nc("b", "agent-b", ["a"]),
    nc("c", "agent-c", ["a"]),
    nc("d", "agent-d", ["b", "c"]),
  ],
};

// ---------------------------------------------------------------------------
// Conditional Graph
// ---------------------------------------------------------------------------

/**
 * Conditional graph: A → B, and C runs only if condition met.
 *
 * ```
 *    A → B
 *    └──► C (conditional: state.A.confidence < 0.5)
 * ```
 */
export const CONDITIONAL_GRAPH: AgentGraphConfig = {
  graphName: "conditional" as GraphName,
  version: "1.0.0",
  description: "Conditional graph: A → B, C runs if A.confidence < 0.5",
  nodes: [
    nc("a", "agent-a"),
    nc("b", "agent-b", ["a"]),
    nc("c", "agent-c", ["a"], {
      condition: {
        type: "predicate",
        expression: "state.a && state.a.confidence < 0.5",
      },
    }),
  ],
};

// ---------------------------------------------------------------------------
// Fan-Out Graph (all parallel)
// ---------------------------------------------------------------------------

/**
 * Fan-out graph: A starts, then B, C, D all run in parallel.
 *
 * ```
 *         ┌──► B
 *    A ───┼──► C
 *         └──► D
 * ```
 */
export const FAN_OUT_GRAPH: AgentGraphConfig = {
  graphName: "fan-out" as GraphName,
  version: "1.0.0",
  description: "Fan-out: A then B, C, D in parallel",
  nodes: [
    nc("a", "agent-a"),
    nc("b", "agent-b", ["a"]),
    nc("c", "agent-c", ["a"]),
    nc("d", "agent-d", ["a"]),
  ],
};

// ---------------------------------------------------------------------------
// All Fixtures
// ---------------------------------------------------------------------------

/**
 * All pre-built graph fixtures for easy iteration in tests.
 */
export const ALL_GRAPH_FIXTURES: AgentGraphConfig[] = [
  SINGLE_NODE,
  LINEAR_2_NODE,
  LINEAR_3_NODE,
  DIAMOND_4_NODE,
  CONDITIONAL_GRAPH,
  FAN_OUT_GRAPH,
];

/**
 * Map of graph name → config for quick lookup.
 */
export const GRAPH_FIXTURES_MAP: Record<string, AgentGraphConfig> = {
  [SINGLE_NODE.graphName]: SINGLE_NODE,
  [LINEAR_2_NODE.graphName]: LINEAR_2_NODE,
  [LINEAR_3_NODE.graphName]: LINEAR_3_NODE,
  [DIAMOND_4_NODE.graphName]: DIAMOND_4_NODE,
  [CONDITIONAL_GRAPH.graphName]: CONDITIONAL_GRAPH,
  [FAN_OUT_GRAPH.graphName]: FAN_OUT_GRAPH,
};
