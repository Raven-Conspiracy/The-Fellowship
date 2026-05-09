/**
 * Agent Registry
 *
 * Central registry that maps logical agent names (`AgentName`) to their
 * Apollo endpoint configuration. This is the **only** place that knows
 * "agent CLASSIFIER lives at Apollo route `/striveworks/classify` with
 * payload schema X".
 *
 * The registry is populated at startup from a YAML config file and can
 * be extended at runtime via `register()`.
 *
 * ## Design
 *
 * - Agent names are case-insensitive unique keys.
 * - Each entry carries the Apollo endpoint route, input/output schemas
 *   (Zod), optional retry policy overrides, and timeout configuration.
 * - The registry is thread-safe for reads (no locks needed in JS) but
 *   writes should happen at startup before any graph execution begins.
 */

import { err, ok } from "neverthrow";
import type { Result } from "neverthrow";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolve } from "node:path";

import type { Logger } from "../core/logger.js";
import type {
  AgentName,
  AgentEndpointConfig,
  AgentNodeConfig,
  ApolloEndpointConfig,
} from "../core/types.js";
import { DomainError, AgentRegistryError } from "../core/errors.js";

// ---------------------------------------------------------------------------
// Zod schemas for YAML config validation
// ---------------------------------------------------------------------------

const YamlAgentEntrySchema = z.object({
  name: z.string().min(1),
  route: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
  max_retries: z.number().int().nonnegative().optional(),
  backoff_base_ms: z.number().int().positive().optional(),
  input_schema: z.record(z.unknown()).optional(),
  output_schema: z.record(z.unknown()).optional(),
  description: z.string().optional(),
});

const YamlRegistrySchema = z.object({
  agents: z.array(YamlAgentEntrySchema).min(1),
  defaults: z
    .object({
      timeout_ms: z.number().int().positive().optional(),
      max_retries: z.number().int().nonnegative().optional(),
      backoff_base_ms: z.number().int().positive().optional(),
    })
    .optional(),
});

type YamlAgentEntry = z.infer<typeof YamlAgentEntrySchema>;
type YamlRegistry = z.infer<typeof YamlRegistrySchema>;

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

/**
 * Maps logical agent names to their Apollo endpoint configuration.
 *
 * ## Usage
 * ```typescript
 * const registry = new AgentRegistry(logger);
 * registry.loadFromYaml("./configs/dev.yaml");
 * const config = registry.get("classifier"); // Result<AgentEndpointConfig>
 * ```
 */
export class AgentRegistry {
  private readonly agents: Map<string, AgentEndpointConfig> = new Map();
  private readonly logger: Logger;
  private defaults: Partial<Pick<AgentEndpointConfig, "timeoutMs" | "maxRetries" | "backoffBaseMs">> = {};

  constructor(logger: Logger) {
    this.logger = logger.child({ component: "AgentRegistry" });
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a single agent endpoint configuration.
   *
   * If an agent with the same name (case-insensitive) already exists,
   * registration fails with an `AgentRegistryError` unless `overwrite`
   * is set to `true`.
   *
   * @param config    - The agent endpoint configuration
   * @param overwrite - If true, overwrite an existing entry
   * @returns `ok(undefined)` on success, `err(AgentRegistryError)` on duplicate
   */
  register(config: AgentEndpointConfig, overwrite = false): Result<void, AgentRegistryError> {
    const normalizedName = normalizeAgentName(config.name);

    if (this.agents.has(normalizedName) && !overwrite) {
      return err(
        new AgentRegistryError(
          `Agent "${config.name}" is already registered. Use overwrite=true to replace.`,
          { agentName: config.name },
        ),
      );
    }

    // Apply defaults for optional fields
    const finalConfig: AgentEndpointConfig = {
      name: config.name,
      route: config.route,
      timeoutMs: config.timeoutMs ?? this.defaults.timeoutMs,
      maxRetries: config.maxRetries ?? this.defaults.maxRetries,
      backoffBaseMs: config.backoffBaseMs ?? this.defaults.backoffBaseMs,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      description: config.description,
    };

    this.agents.set(normalizedName, finalConfig);

    this.logger.info(
      { agentName: config.name, route: config.route, overwrite },
      overwrite ? "Agent endpoint updated in registry" : "Agent endpoint registered",
    );

    return ok(undefined);
  }

  /**
   * Bulk-register multiple agent configurations.
   *
   * @param configs - Array of agent endpoint configurations
   * @returns `ok(undefined)` or `err(AgentRegistryError)` on first duplicate
   */
  registerAll(configs: AgentEndpointConfig[]): Result<void, AgentRegistryError> {
    for (const config of configs) {
      const result = this.register(config, false);
      if (result.isErr()) {
        return result;
      }
    }
    return ok(undefined);
  }

  /**
   * Load agent configurations from a YAML file.
   *
   * The YAML file is expected to follow this structure:
   * ```yaml
   * agents:
   *   - name: classify
   *     route: /striveworks/classify
   *     timeout_ms: 30000
   *     max_retries: 3
   *     backoff_base_ms: 500
   *     description: "Classifies incoming incidents"
   * defaults:
   *   timeout_ms: 20000
   *   max_retries: 2
   * ```
   *
   * @param configPath - Absolute or relative path to the YAML config file
   * @returns `ok(number)` with the count of agents loaded, or `err(DomainError)`
   */
  loadFromYaml(configPath: string): Result<number, DomainError> {
    let raw: string;
    try {
      raw = readFileSync(resolve(configPath), "utf-8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new AgentRegistryError(`Failed to read agent registry YAML: ${message}`, {
          configPath,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new AgentRegistryError(`Failed to parse agent registry YAML: ${message}`, {
          configPath,
          cause: error instanceof Error ? error : undefined,
        }),
      );
    }

    const validation = YamlRegistrySchema.safeParse(parsed);
    if (!validation.success) {
      return err(
        new AgentRegistryError(`Invalid agent registry YAML schema: ${validation.error.message}`, {
          configPath,
          detail: validation.error.issues as unknown as Record<string, unknown>,
          cause: validation.error,
        }),
      );
    }

    const yamlData: YamlRegistry = validation.data;

    // Apply defaults first
    if (yamlData.defaults) {
      this.defaults = {
        timeoutMs: yamlData.defaults.timeout_ms,
        maxRetries: yamlData.defaults.max_retries,
        backoffBaseMs: yamlData.defaults.backoff_base_ms,
      };
    }

    // Register each agent
    let loaded = 0;
    for (const entry of yamlData.agents) {
      const config = this.yamlEntryToConfig(entry);
      const regResult = this.register(config, false);
      if (regResult.isErr()) {
        return err(regResult.error);
      }
      loaded++;
    }

    this.logger.info({ count: loaded, configPath }, "Agent registry loaded from YAML");
    return ok(loaded);
  }

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  /**
   * Retrieve an agent's endpoint configuration by name (case-insensitive).
   *
   * @param name - The logical agent name
   * @returns `ok(AgentEndpointConfig)` or `err(AgentRegistryError)` if not found
   */
  get(name: AgentName): Result<AgentEndpointConfig, AgentRegistryError> {
    const normalized = normalizeAgentName(name);
    const config = this.agents.get(normalized);

    if (!config) {
      return err(
        new AgentRegistryError(`Agent "${name}" not found in registry`, { agentName: name }),
      );
    }

    return ok(config);
  }

  /**
   * Check if an agent name is registered.
   *
   * @param name - The logical agent name
   * @returns `true` if the agent exists in the registry
   */
  has(name: AgentName): boolean {
    return this.agents.has(normalizeAgentName(name));
  }

  /**
   * List all registered agent names.
   *
   * @returns Array of agent names sorted alphabetically
   */
  list(): AgentName[] {
    return Array.from(this.agents.keys()).sort() as AgentName[];
  }

  /**
   * Return the total number of registered agents.
   */
  get size(): number {
    return this.agents.size;
  }

  /**
   * Remove an agent from the registry.
   *
   * @param name - The logical agent name to remove
   * @returns `true` if the agent was found and removed
   */
  remove(name: AgentName): boolean {
    const normalized = normalizeAgentName(name);
    const existed = this.agents.delete(normalized);
    if (existed) {
      this.logger.info({ agentName: name }, "Agent removed from registry");
    }
    return existed;
  }

  /**
   * Clear all registered agents.
   */
  clear(): void {
    this.agents.clear();
    this.logger.info("Agent registry cleared");
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Convert a parsed YAML entry into an AgentEndpointConfig.
   */
  private yamlEntryToConfig(entry: YamlAgentEntry): AgentEndpointConfig {
    return {
      name: entry.name as AgentName,
      route: entry.route,
      timeoutMs: entry.timeout_ms,
      maxRetries: entry.max_retries,
      backoffBaseMs: entry.backoff_base_ms,
      inputSchema: entry.input_schema,
      outputSchema: entry.output_schema,
      description: entry.description,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an agent name for case-insensitive lookup.
 */
function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}
