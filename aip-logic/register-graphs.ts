/**
 * AIP Logic — Register Graphs
 *
 * Registers all known `AgentGraph` definitions that the orchestration layer
 * can execute. This is where the team defines **which graphs exist** and
 * **what agents they comprise**.
 *
 * Every graph is defined using the `GraphBuilder` fluent API, which ensures
 * the graph is a valid DAG (no cycles) and all referenced agents exist in
 * the `AgentRegistry`.
 *
 * ## Adding a New Graph
 *
 * 1. Define the graph below using `GraphBuilder`
 * 2. Add it to the `ALL_GRAPHS` array
 * 3. Ensure all referenced agents are registered in the agent registry YAML
 * 4. Add unit tests for the graph topology
 *
 * ## Graph Catalog
 *
 * | Graph Name          | Description                           | Phase |
 * |---------------------|---------------------------------------|-------|
 * | `incident-triage`   | Classify → Analyze → Summarize → Escalate | 1 |
 * | `data-enrichment`   | Fetch → Normalize → Merge → Validate  | 2     |
 * | `report-generation` | Gather → Analyze → Format → Deliver   | 2     |
 *
 * @module aip-logic/register-graphs
 */

import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";

import type {
  AgentGraph,
  AgentGraphConfig,
  GraphName,
  DomainError,
} from "../orchestrator/src/core/types.js";
import { GraphValidationError } from "../orchestrator/src/core/errors.js";
import { GraphBuilder } from "../orchestrator/src/graph/graph-builder.js";
import type { Logger } from "../orchestrator/src/core/logger.js";

// ---------------------------------------------------------------------------
// Agent Name Constants
// ---------------------------------------------------------------------------

/**
 * Logical agent names used in graph definitions.
 * These MUST match the names registered in the agent registry YAML.
 */
const AGENTS = {
  CLASSIFIER: "classifier" as const,
  ANALYZER: "analyzer" as const,
  SUMMARIZER: "summarizer" as const,
  ESCALATOR: "escalator" as const,
  FETCHER: "fetcher" as const,
  NORMALIZER: "normalizer" as const,
  MERGER: "merger" as const,
  VALIDATOR: "validator" as const,
  GATHERER: "gatherer" as const,
  FORMATTER: "formatter" as const,
  DELIVERER: "deliverer" as const,
} as const;

// ---------------------------------------------------------------------------
// Graph Definitions
// ---------------------------------------------------------------------------

/**
 * **Incident Triage Graph** (Phase 1)
 *
 * A linear-then-conditional graph for triaging incoming incidents:
 *
 * ```
 * classify ──► analyze ──► summarize
 *                  │
 *                  └──► escalate (conditional: confidence < 0.7)
 * ```
 *
 * Flow:
 * 1. **classify** — Categorizes the incident (e.g. "database", "network", "auth")
 * 2. **analyze** — Deep-dives into the incident, produces confidence score
 * 3. **summarize** — Creates a human-readable summary of findings
 * 4. **escalate** — (CONDITIONAL) If confidence < 0.7, escalates to on-call
 *
 * This is the first graph to be deployed and demoed.
 */
export const INCIDENT_TRIAGE_GRAPH: AgentGraphConfig = {
  graphName: "incident-triage" as GraphName,
  version: "0.1.0",
  description: "Classify, analyze, summarize, and optionally escalate incoming incidents",
  nodes: [
    {
      id: "classify",
      agentName: AGENTS.CLASSIFIER,
      dependsOn: [],
      inputMapping: ["incident_id", "raw_text"],
    },
    {
      id: "analyze",
      agentName: AGENTS.ANALYZER,
      dependsOn: ["classify"],
      inputMapping: ["incident_id", "classify"],
    },
    {
      id: "summarize",
      agentName: AGENTS.SUMMARIZER,
      dependsOn: ["analyze"],
      inputMapping: ["incident_id", "classify", "analyze"],
    },
    {
      id: "escalate",
      agentName: AGENTS.ESCALATOR,
      dependsOn: ["analyze"],
      condition: {
        type: "predicate",
        expression: "state.analyze.confidence < 0.7",
      },
      inputMapping: ["incident_id", "classify", "analyze"],
    },
  ],
};

/**
 * **Data Enrichment Graph** (Phase 2)
 *
 * A fan-out/fan-in graph that enriches raw data through parallel
 * normalization and merging:
 *
 * ```
 *                  ┌──► normalize ──┐
 * fetch ──┤                      ├──► merge ──► validate
 *                  └──► normalize ──┘
 * ```
 *
 * Flow:
 * 1. **fetch** — Retrieves raw data from source(s)
 * 2. **normalize** (×2 parallel) — Normalizes different facets of the data
 * 3. **merge** — Merges normalized results into a unified record
 * 4. **validate** — Validates the merged data against a schema
 */
export const DATA_ENRICHMENT_GRAPH: AgentGraphConfig = {
  graphName: "data-enrichment" as GraphName,
  version: "0.1.0",
  description: "Fetch, normalize (parallel), merge, and validate data records",
  nodes: [
    {
      id: "fetch",
      agentName: AGENTS.FETCHER,
      dependsOn: [],
      inputMapping: ["source_ids", "query_params"],
    },
    {
      id: "normalize-a",
      agentName: AGENTS.NORMALIZER,
      dependsOn: ["fetch"],
      inputMapping: ["fetch"],
    },
    {
      id: "normalize-b",
      agentName: AGENTS.NORMALIZER,
      dependsOn: ["fetch"],
      inputMapping: ["fetch"],
    },
    {
      id: "merge",
      agentName: AGENTS.MERGER,
      dependsOn: ["normalize-a", "normalize-b"],
      inputMapping: ["normalize-a", "normalize-b"],
    },
    {
      id: "validate",
      agentName: AGENTS.VALIDATOR,
      dependsOn: ["merge"],
      inputMapping: ["merge"],
    },
  ],
};

/**
 * **Report Generation Graph** (Phase 2)
 *
 * A sequential pipeline with a conditional delivery gate:
 *
 * ```
 * gather ──► analyze ──► format ──► deliver
 *                              │
 *                              └── (conditional: only if approved)
 * ```
 */
export const REPORT_GENERATION_GRAPH: AgentGraphConfig = {
  graphName: "report-generation" as GraphName,
  version: "0.1.0",
  description: "Gather data, analyze, format, and conditionally deliver reports",
  nodes: [
    {
      id: "gather",
      agentName: AGENTS.GATHERER,
      dependsOn: [],
      inputMapping: ["report_type", "date_range", "filters"],
    },
    {
      id: "analyze",
      agentName: AGENTS.ANALYZER,
      dependsOn: ["gather"],
      inputMapping: ["report_type", "gather"],
    },
    {
      id: "format",
      agentName: AGENTS.FORMATTER,
      dependsOn: ["analyze"],
      inputMapping: ["report_type", "analyze"],
    },
    {
      id: "deliver",
      agentName: AGENTS.DELIVERER,
      dependsOn: ["format"],
      condition: {
        type: "predicate",
        expression: "state.format.approved === true",
      },
      inputMapping: ["report_type", "format"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Master Graph Catalog
// ---------------------------------------------------------------------------

/**
 * All registered agent graph configurations.
 *
 * To add a new graph, define it above and add it to this array.
 * The orchestrator will automatically pick it up at startup.
 */
export const ALL_GRAPHS: AgentGraphConfig[] = [
  INCIDENT_TRIAGE_GRAPH,
  DATA_ENRICHMENT_GRAPH,
  REPORT_GENERATION_GRAPH,
];

/**
 * Registry of built graph instances (lazy-initialized).
 */
const graphRegistry = new Map<GraphName, AgentGraph>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all known graphs with the orchestrator's graph runtime.
 *
 * This function:
 * 1. Validates each graph configuration
 * 2. Builds an `AgentGraph` instance using `GraphBuilder`
 * 3. Registers it in the internal graph registry
 *
 * Call this once at startup before any graph execution.
 *
 * @param logger - Structured logger instance
 * @returns `ok(number)` with the count of graphs registered, or `err(DomainError)`
 */
export function registerAllGraphs(logger: Logger): Result<number, DomainError> {
  let registered = 0;

  for (const config of ALL_GRAPHS) {
    const result = registerGraph(config, logger);
    if (result.isErr()) {
      return err(result.error);
    }
    registered++;
  }

  logger.info({ count: registered }, "All agent graphs registered successfully");
  return ok(registered);
}

/**
 * Register a single graph configuration.
 *
 * @param config - The graph configuration to register
 * @param logger - Structured logger instance
 * @returns `ok(AgentGraph)` with the built graph, or `err(DomainError)`
 */
export function registerGraph(
  config: AgentGraphConfig,
  logger: Logger,
): Result<AgentGraph, DomainError> {
  const graphLogger = logger.child({ graphName: config.graphName });

  graphLogger.info(
    { version: config.version, nodeCount: config.nodes.length },
    "Registering agent graph",
  );

  // Build the graph using GraphBuilder
  const buildResult = buildGraphFromConfig(config, graphLogger);
  if (buildResult.isErr()) {
    graphLogger.error({ err: buildResult.error }, "Failed to build agent graph");
    return err(buildResult.error);
  }

  const graph = buildResult.value;

  // Validate the graph
  const validationResult = graph.validate();
  if (validationResult.isErr()) {
    graphLogger.error({ err: validationResult.error }, "Graph validation failed");
    return err(validationResult.error);
  }

  // Store in registry
  graphRegistry.set(config.graphName, graph);

  graphLogger.info("Agent graph registered and validated");
  return ok(graph);
}

/**
 * Build an `AgentGraph` instance from its configuration using `GraphBuilder`.
 *
 * @param config - The graph configuration
 * @param logger - Logger instance
 * @returns `ok(AgentGraph)` or `err(GraphValidationError)`
 */
function buildGraphFromConfig(
  config: AgentGraphConfig,
  logger: Logger,
): Result<AgentGraph, GraphValidationError> {
  try {
    const builder = new GraphBuilder(config.graphName, logger);

    // Add each node
    for (const nodeConfig of config.nodes) {
      builder.node(nodeConfig.id, nodeConfig.agentName, {
        dependsOn: nodeConfig.dependsOn,
        condition: nodeConfig.condition,
        inputMapping: nodeConfig.inputMapping,
        retryPolicy: nodeConfig.retryPolicy,
        timeoutMs: nodeConfig.timeoutMs,
      });
    }

    const graph = builder.build();
    return ok(graph);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new GraphValidationError(
        `Failed to build graph "${config.graphName}": ${message}`,
        {
          graphName: config.graphName,
          cause: error instanceof Error ? error : undefined,
        },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Retrieve a registered graph by name.
 *
 * @param graphName - The logical name of the graph
 * @returns `ok(AgentGraph)` if found, `err(GraphValidationError)` if not
 */
export function getGraph(graphName: GraphName): Result<AgentGraph, GraphValidationError> {
  const graph = graphRegistry.get(graphName);

  if (!graph) {
    return err(
      new GraphValidationError(
        `Graph "${graphName}" is not registered. Did you call registerAllGraphs()?`,
        { graphName },
      ),
    );
  }

  return ok(graph);
}

/**
 * List all registered graph names.
 *
 * @returns Array of graph names sorted alphabetically
 */
export function listGraphs(): GraphName[] {
  return Array.from(graphRegistry.keys()).sort();
}

/**
 * Check if a graph is registered.
 *
 * @param graphName - The logical graph name
 * @returns `true` if the graph exists in the registry
 */
export function hasGraph(graphName: GraphName): boolean {
  return graphRegistry.has(graphName);
}
