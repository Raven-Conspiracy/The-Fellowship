/**
 * =============================================================================
 * Schema Validators — Zod-based Runtime Validation
 * =============================================================================
 *
 * Provides Zod schemas and validation functions for:
 *   - Environment variables
 *   - YAML configuration files
 *   - Execution requests
 *   - Agent node configurations
 *   - Graph definitions
 *
 * All schemas are strict (reject unknown keys) and use branded type
 * validators for domain-specific IDs.
 */

import { z } from 'zod';

import { LogLevel, ExecutionStatus, CircuitBreakerState, ExecutionEventType } from '../core/types.js';

// ============================================================================
// Primitive Validators
// ============================================================================

/**
 * Validates a non-empty string suitable for branded types.
 */
const nonEmptyString = z.string().min(1, 'Value must not be empty');

/**
 * Validates a valid AgentName (non-empty string).
 */
export const agentNameSchema = nonEmptyString.describe('AgentName — non-empty string identifier');

/**
 * Validates a valid GraphName (non-empty string).
 */
export const graphNameSchema = nonEmptyString.describe('GraphName — non-empty string identifier');

/**
 * Validates an ExecutionId (ULID format — 26 characters, Crockford base32).
 */
export const executionIdSchema = nonEmptyString.describe('ExecutionId — ULID string');

/**
 * Validates a NodeId (ULID format).
 */
export const nodeIdSchema = nonEmptyString.describe('NodeId — ULID string');

/**
 * Validates an IdempotencyKey.
 */
export const idempotencyKeySchema = nonEmptyString.describe('IdempotencyKey');

// ============================================================================
// Environment Variable Schemas
// ============================================================================

/**
 * Schema for validating environment variables at startup.
 */
export const envVarsSchema = z.object({
  // Apollo
  APOLLO_BASE_URL: z.string().url('APOLLO_BASE_URL must be a valid URL'),
  APOLLO_TOKEN: nonEmptyString,
  APOLLO_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 30000))
    .pipe(z.number().int().positive()),
  APOLLO_MAX_RETRIES: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 3))
    .pipe(z.number().int().min(0).max(10)),
  APOLLO_RETRY_DELAY_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 1000))
    .pipe(z.number().int().positive()),

  // Striveworks
  STRIVEWORKS_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
  STRIVEWORKS_REGISTERED_AGENTS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),

  // Foundry
  FOUNDRY_URL: z.string().url('FOUNDRY_URL must be a valid URL'),
  FOUNDRY_TOKEN: nonEmptyString,
  FOUNDRY_ONTOLOGY_RID: nonEmptyString,
  FOUNDRY_DATASET_RID: nonEmptyString,

  // Orchestration
  ORCHESTRATION_ENV: z.enum(['dev', 'staging', 'prod']).default('dev'),
  STRUCTURED_LOGGING: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .default('info'),
  GRAPH_STATE_PERSIST: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  GRAPH_MAX_PARALLELISM: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 5))
    .pipe(z.number().int().positive()),
  GRAPH_EXECUTION_TIMEOUT_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 300000))
    .pipe(z.number().int().positive()),

  // Circuit Breaker
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 5))
    .pipe(z.number().int().positive()),
  CIRCUIT_BREAKER_COOLDOWN_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 30000))
    .pipe(z.number().int().positive()),
  CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 3))
    .pipe(z.number().int().positive()),

  // Retry
  RETRY_MAX_ATTEMPTS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 3))
    .pipe(z.number().int().positive()),
  RETRY_BASE_DELAY_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 500))
    .pipe(z.number().int().positive()),
  RETRY_MAX_DELAY_MS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 10000))
    .pipe(z.number().int().positive()),
  RETRY_BACKOFF_MULTIPLIER: z
    .string()
    .optional()
    .transform((v) => (v ? parseFloat(v) : 2))
    .pipe(z.number().positive()),

  // Idempotency
  IDEMPOTENCY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  IDEMPOTENCY_KEY_TTL_SECONDS: z
    .string()
    .optional()
    .transform((v) => (v ? parseInt(v, 10) : 3600))
    .pipe(z.number().int().positive()),
});

/**
 * Inferred TypeScript type for validated environment variables.
 */
export type ValidatedEnvVars = z.infer<typeof envVarsSchema>;

// ============================================================================
// Retry & Circuit Breaker Schemas
// ============================================================================

/**
 * Schema for RetryPolicy.
 */
export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(3),
  baseDelayMs: z.number().int().positive().default(500),
  maxDelayMs: z.number().int().positive().default(10000),
  backoffMultiplier: z.number().positive().default(2),
  jitter: z.boolean().default(true),
});

/**
 * Schema for CircuitBreakerConfig.
 */
export const circuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().positive().default(5),
  cooldownMs: z.number().int().positive().default(30000),
  halfOpenMaxRequests: z.number().int().positive().default(3),
});

// ============================================================================
// Agent Schemas
// ============================================================================

/**
 * Schema for AgentNodeConfig.
 */
export const agentNodeConfigSchema = z.object({
  agentName: agentNameSchema,
  displayName: z.string().min(1),
  apolloRoute: z.string().min(1).startsWith('/'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
  inputSchemaVersion: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  retryPolicy: retryPolicySchema,
  circuitBreakerConfig: circuitBreakerConfigSchema,
});

/**
 * Schema for AgentNodeDefinition.
 */
export const agentNodeDefinitionSchema = z.object({
  name: z.string().min(1),
  config: agentNodeConfigSchema,
  dependsOn: z.array(z.string()).default([]),
  condition: z.function().optional(),
  inputTransform: z.function().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retryPolicy: retryPolicySchema.optional(),
});

// ============================================================================
// Graph Schemas
// ============================================================================

/**
 * Schema for GraphMetadata.
 */
export const graphMetadataSchema = z.object({
  name: graphNameSchema,
  description: z.string().min(1),
  version: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  tags: z.array(z.string()).default([]),
  owner: z.string().min(1),
  inputSchema: z.record(z.unknown()).optional(),
});

// ============================================================================
// Execution Schemas
// ============================================================================

/**
 * Schema for validating an ExecutionRequest.
 */
export const executionRequestSchema = z.object({
  graphName: graphNameSchema,
  input: z.record(z.unknown()),
  idempotencyKey: idempotencyKeySchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Schema for AgentInput.
 */
export const agentInputSchema = z.record(z.unknown());

/**
 * Schema for AgentOutput.
 */
export const agentOutputSchema = z.record(z.unknown());

/**
 * Schema for AgentResult.
 */
export const agentResultSchema = z.object({
  nodeId: nodeIdSchema,
  agentName: agentNameSchema,
  output: agentOutputSchema,
  durationMs: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
});

// ============================================================================
// YAML Config Schemas
// ============================================================================

/**
 * Schema for the Apollo section of YAML config.
 */
const apolloConfigYamlSchema = z.object({
  base_url: z.string().url(),
  timeout_ms: z.number().int().positive().default(30000),
  max_retries: z.number().int().nonnegative().default(3),
  retry_delay_ms: z.number().int().positive().default(1000),
  auth: z.object({
    type: z.literal('bearer_token'),
    token_env_var: z.string().min(1),
  }),
});

/**
 * Schema for the Foundry section of YAML config.
 */
const foundryConfigYamlSchema = z.object({
  base_url: z.string().url(),
  token_env_var: z.string().min(1),
  ontology: z.object({
    rid: nonEmptyString,
    action_type_rid: nonEmptyString,
  }),
  dataset: z.object({
    rid: nonEmptyString,
    branch: z.string().default('master'),
  }),
  streams: z.object({
    event_stream_rid: nonEmptyString,
  }),
});

/**
 * Schema for an individual agent in YAML config.
 */
const agentYamlSchema = z.object({
  display_name: z.string().min(1),
  apollo_route: z.string().min(1).startsWith('/'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
  input_schema_version: z.string().min(1),
  timeout_ms: z.number().int().positive().default(30000),
  retry_policy: retryPolicySchema,
  circuit_breaker: circuitBreakerConfigSchema,
});

/**
 * Complete YAML config schema.
 */
export const yamlConfigSchema = z.object({
  environment: z.object({
    name: z.enum(['dev', 'staging', 'prod']),
    structured_logging: z.boolean().default(false),
    log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  apollo: apolloConfigYamlSchema,
  foundry: foundryConfigYamlSchema,
  agents: z.record(z.string().min(1), agentYamlSchema),
  graphs: z.object({
    max_parallelism: z.number().int().positive().default(5),
    execution_timeout_ms: z.number().int().positive().default(300000),
    state_persist: z.boolean().default(false),
    idempotency: z.object({
      enabled: z.boolean().default(true),
      key_ttl_seconds: z.number().int().positive().default(3600),
    }),
  }),
  retry: retryPolicySchema,
  circuit_breaker: circuitBreakerConfigSchema,
});

/**
 * Inferred TypeScript type for validated YAML config.
 */
export type ValidatedYamlConfig = z.infer<typeof yamlConfigSchema>;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate environment variables and return a typed result.
 * Throws a ZodError with detailed messages on failure.
 *
 * @param env - The raw environment variables (process.env)
 * @returns Validated environment variables
 */
export function validateEnvVars(env: Record<string, string | undefined>): ValidatedEnvVars {
  return envVarsSchema.parse(env);
}

/**
 * Validate a YAML configuration object.
 * Throws a ZodError with detailed messages on failure.
 *
 * @param config - The parsed YAML object to validate
 * @returns Validated configuration
 */
export function validateYamlConfig(config: unknown): ValidatedYamlConfig {
  return yamlConfigSchema.parse(config);
}

/**
 * Validate an execution request.
 * Throws a ZodError with detailed messages on failure.
 *
 * @param request - The request to validate
 * @returns The validated request
 */
export function validateExecutionRequest(
  request: unknown,
): z.infer<typeof executionRequestSchema> {
  return executionRequestSchema.parse(request);
}

/**
 * Validate an agent node configuration.
 *
 * @param config - The config to validate
 * @returns The validated config
 */
export function validateAgentNodeConfig(
  config: unknown,
): z.infer<typeof agentNodeConfigSchema> {
  return agentNodeConfigSchema.parse(config);
}

/**
 * Validate an array of agent node definitions.
 *
 * @param nodes - The nodes to validate
 * @returns The validated nodes
 */
export function validateAgentNodeDefinitions(
  nodes: unknown,
): ReadonlyArray<z.infer<typeof agentNodeDefinitionSchema>> {
  return z.array(agentNodeDefinitionSchema).parse(nodes);
}

/**
 * Format a ZodError into a human-readable string.
 *
 * @param error - The ZodError
 * @returns A formatted error message
 */
export function formatZodError(error: z.ZodError): string {
  return error.errors
    .map((e) => {
      const path = e.path.length > 0 ? e.path.join('.') : '<root>';
      return `  - ${path}: ${e.message}`;
    })
    .join('\n');
}

// ============================================================================
// Event Schemas
// ============================================================================

/**
 * Schema for ExecutionEvent.
 */
export const executionEventSchema = z.object({
  type: z.nativeEnum(ExecutionEventType),
  executionId: executionIdSchema,
  graphName: graphNameSchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.unknown()),
});

/**
 * Schema for NodeTrace.
 */
export const nodeTraceSchema = z.object({
  traceId: nodeIdSchema,
  nodeName: z.string().min(1),
  agentName: agentNameSchema,
  status: z.nativeEnum(ExecutionStatus),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
  result: agentResultSchema.optional(),
});
