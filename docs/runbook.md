# Runbook — Operations

> **Audience:** On-call engineers, DevOps, and anyone deploying or debugging
> the orchestration layer  
> **Status:** Living document  
> **Last Updated:** 2026-05

---

## Table of Contents

1. [Deployment](#deployment)
2. [Configuration](#configuration)
3. [Monitoring](#monitoring)
4. [Debugging](#debugging)
5. [Incident Response](#incident-response)
6. [Rollback](#rollback)
7. [Maintenance Tasks](#maintenance-tasks)

---

## Deployment

### Prerequisites

- Foundry Code Workspace with TypeScript SDK ≥ 5.x
- Node.js ≥ 20.x (for local development)
- Access to Apollo (dev/staging/prod URLs)
- Valid `APOLLO_TOKEN` (see `docs/apollo-bridge.md`)
- Valid `FOUNDRY_TOKEN` for Ontology writes and Stream events

### Local Development

```bash
# 1. Install dependencies
cd orchestrator
npm install

# 2. Run type checks
npm run typecheck

# 3. Run unit tests (no external dependencies)
npm test

# 4. Run integration tests (requires Apollo dev access)
ORCHESTRATION_ENV=dev npm run test:integration
```

### Staging Deployment

1. Merge PR to `staging` branch
2. CI pipeline runs: lint → typecheck → unit tests → integration tests
3. If all pass, build: `npm run build`
4. Deploy `dist/` to Foundry Code Workspace (staging environment)
5. Smoke test: trigger `incident-triage` graph with a test payload
6. Verify result appears in Foundry Ontology (staging)

### Production Deployment

1. Create a release tag: `git tag -a v0.1.0 -m "Release v0.1.0"`
2. Push tag: `git push origin v0.1.0`
3. CI pipeline runs full test suite
4. Manual approval gate (required for prod)
5. Deploy `dist/` to Foundry Code Workspace (production environment)
6. **Canary:** Enable for 5% of traffic for 15 minutes
7. Monitor error rates and latency
8. Full rollout if canary is clean
9. **Rollback immediately** if error rate exceeds baseline

### Environment Variables (Production)

```bash
ORCHESTRATION_ENV=prod
APOLLO_BASE_URL=https://apollo.production.palantirfoundry.com
APOLLO_TOKEN=<managed-by-apollo>
FOUNDRY_URL=https://your-enrollment.palantirfoundry.com
FOUNDRY_TOKEN=<managed-by-foundry>
LOG_LEVEL=info                    # warn in prod to reduce noise
STRUCTURED_LOGGING=true
GRAPH_STATE_PERSIST=true          # Phase 3: durable checkpoints
```

---

## Configuration

### Config File Hierarchy

Configuration is loaded from the environment-aware YAML file:

```
configs/
├── dev.yaml          ← Local development
├── staging.yaml      ← Staging environment
└── prod.yaml         ← Production environment
```

The active config is determined by `ORCHESTRATION_ENV` (falls back to `NODE_ENV`).

### Key Configuration Parameters

| Parameter | Location | Description | Default |
|---|---|---|---|
| `apollo.baseUrl` | `configs/*.yaml` | Apollo base URL | (required) |
| `apollo.timeoutMs` | `configs/*.yaml` | Default request timeout | `30000` |
| `apollo.retryPolicy.maxAttempts` | `configs/*.yaml` | Default retry count | `3` |
| `apollo.circuitBreaker.failureThreshold` | `configs/*.yaml` | Failures before open | `5` |
| `apollo.circuitBreaker.resetTimeoutMs` | `configs/*.yaml` | OPEN → HALF_OPEN timeout | `30000` |
| `foundry.actionType` | `configs/*.yaml` | Ontology Action Type name | `orchestration-graph-result` |
| `foundry.streamEnabled` | `configs/*.yaml` | Enable event streaming | `true` (prod) |
| `agents` | `configs/*.yaml` | Agent endpoint registry | (at least one) |

### Changing Config at Runtime

Config changes require a Code Workspace restart. For emergency config changes:

1. Update the YAML config file
2. Restart the Code Workspace
3. Verify with a smoke test

---

## Monitoring

### Key Metrics

| Metric | Source | Alert Threshold |
|---|---|---|
| Graph execution success rate | Foundry Streams events | < 95% over 5 min |
| P99 graph execution latency | Foundry Streams events | > 60s |
| Circuit breaker open rate | `ApolloClient` logs | > 0 for > 5 min |
| Apollo error rate (5xx) | `ApolloClient` logs | > 10% over 5 min |
| Agent retry rate | `AgentExecutor` logs | > 20% over 5 min |
| Ontology write failure rate | `OntologyWriter` logs | > 5% over 5 min |

### Log Levels

| Level | When to Use |
|---|---|
| `debug` | Local development, troubleshooting a specific issue |
| `info` | Normal operation — graph start/complete, node start/complete |
| `warn` | Retries, circuit breaker state changes, non-fatal errors |
| `error` | Graph failures, auth failures, Ontology write failures |

### Foundry Streams Events

Every graph execution emits events to the configured Foundry Stream:

- `graph.started` / `graph.completed` / `graph.error`
- `node.started` / `node.completed` / `node.error` / `node.skipped`
- `graph.node_checkpoint` (Phase 3)

Use Foundry's Streams dashboard to monitor event throughput and error patterns.

---

## Debugging

### Common Issues

#### Graph Fails Immediately with "Circuit Breaker Open"

**Symptoms:**
- `CircuitBreakerOpenError` in logs
- Any graph execution fails at the first node

**Diagnosis:**
```bash
# Check Apollo health manually
curl -H "Authorization: Bearer $APOLLO_TOKEN" $APOLLO_BASE_URL/health
```

**Resolution:**
1. If Apollo is healthy, manually reset the circuit breaker
2. If Apollo is down, wait for Apollo recovery — circuit will auto-reset after `resetTimeoutMs`
3. Check Apollo's own monitoring dashboard

#### Agent Call Fails with "Agent Not Found in Registry"

**Symptoms:**
- `AgentRegistryError` in logs
- Specific agent name cannot be resolved

**Diagnosis:**
- Check the agent name spelling in the graph definition
- Verify the agent exists in `configs/<env>.yaml`
- Check for case sensitivity (agent names are case-insensitive)

**Resolution:**
1. Add the agent to the registry YAML
2. Restart Code Workspace
3. Re-run the graph

#### Graph Takes Too Long / Timeout

**Symptoms:**
- `TimeoutError` in logs
- Graph runs for > expected duration

**Diagnosis:**
- Check `LOG_LEVEL=debug` to see per-node timing
- Identify the slow agent
- Check if Apollo or Striveworks is experiencing latency

**Resolution:**
1. Increase `timeout_ms` for the slow agent in the registry YAML
2. Check if the agent can be optimized
3. For parallel graphs, ensure independent nodes are actually running in parallel

#### Ontology Write Fails

**Symptoms:**
- `FoundryWriteError` or `FoundryAuthError` in logs
- Graph completes but result is not visible in Ontology

**Diagnosis:**
- Verify `FOUNDRY_TOKEN` is valid
- Check the Action Type exists in Foundry
- Verify the payload schema matches the Action Type definition

**Resolution:**
1. Rotate `FOUNDRY_TOKEN`
2. Update Action Type schema if payload format changed
3. Re-run the graph

### Enabling Debug Logging

```bash
# Set log level to debug
LOG_LEVEL=debug

# Or in code:
const logger = createLogger({ level: "debug", component: "my-component" });
```

### Tracing a Specific Execution

Every graph execution has a unique `executionId` (ULID). Search logs for:

```
executionId: "01J..."
```

All events for that execution will share the same `executionId` and
`correlationId`.

---

## Incident Response

### Severity Levels

| Severity | Definition | Response Time | Example |
|---|---|---|---|
| **SEV1** | Orchestration layer completely down | 15 min | All graphs fail, circuit breaker stuck open |
| **SEV2** | Specific graph or agent degraded | 30 min | One agent consistently timing out |
| **SEV3** | Non-critical anomaly | Next business day | Elevated retry rate, no user impact |

### SEV1: Orchestration Layer Down

1. **Declare incident** in incident management tool
2. **Check Apollo:** Is Apollo healthy? (`/health` endpoint)
3. **Check Code Workspace:** Is the TypeScript runtime healthy?
4. **Check logs:** What error pattern is dominant?
5. **If circuit breaker:** Determine if Apollo is truly down or if breaker is stale
6. **Rollback** to last known good deployment if recent deploy is suspected
7. **Escalate** to Apollo team if Apollo is the root cause
8. **Escalate** to Striveworks team if all agents are failing

### SEV2: Specific Graph Degraded

1. **Identify the graph:** Which graph is failing?
2. **Identify the node:** Which node(s) in the graph are failing?
3. **Check agent health:** Is the Striveworks agent healthy?
4. **Check agent config:** Are timeout/retry settings appropriate?
5. **If transient:** Increase retry count or timeout temporarily
6. **If persistent:** Contact Striveworks team

### SEV3: Elevated Retry Rate

1. **Check Apollo latency** — is Apollo slow?
2. **Check Striveworks latency** — is a specific agent slow?
3. **Review recent changes** — did a new agent version deploy?
4. **Monitor** — if retry rate returns to normal, no action needed

---

## Rollback

### Rolling Back a Deployment

1. Identify the last known good version tag: `git tag -l`
2. Checkout the tag: `git checkout v0.0.9`
3. Build: `npm run build`
4. Deploy `dist/` to Code Workspace
5. Smoke test with a known-good graph
6. Monitor for 5 minutes

### Rolling Back Agent Configuration

1. Revert the YAML config change
2. Restart Code Workspace
3. Smoke test

### Circuit Breaker Emergency Reset

If the circuit breaker is open but Apollo is healthy:

```typescript
// In Code Workspace console or a debug function:
import { getApolloClient } from "./orchestrator/src/adapters/apollo/apollo-client.js";
const client = getApolloClient();
client.resetCircuitBreaker();
```

---

## Maintenance Tasks

### Rotating Apollo Token

1. Generate a new token in Apollo's token management console
2. Update `APOLLO_TOKEN` in the Code Workspace environment variables
3. Restart Code Workspace
4. Verify: run a smoke test graph
5. Revoke the old token after confirming the new one works

### Rotating Foundry Token

1. Generate a new service token in Foundry
2. Update `FOUNDRY_TOKEN` in the Code Workspace environment variables
3. Restart Code Workspace
4. Verify: trigger a graph and check Ontology for the result

### Adding a New Agent

1. Deploy the Striveworks agent (Striveworks team)
2. Register the Apollo route (Apollo team)
3. Add the agent to `configs/<env>.yaml`
4. Restart Code Workspace
5. Verify: run a test graph that calls the new agent

### Updating Agent Dependencies

```bash
# Check for outdated packages
npm outdated

# Update within semver range
npm update

# Run full test suite
npm test && npm run test:integration

# If all pass, commit the updated package-lock.json
```

---

## Quick Reference Commands

```bash
# Run all unit tests
cd orchestrator && npm test

# Run integration tests
cd orchestrator && npm run test:integration

# Type-check
cd orchestrator && npm run typecheck

# Build
cd orchestrator && npm run build

# Check Apollo health (from Code Workspace)
node -e "
  const { ApolloClient } = require('./dist/adapters/apollo/apollo-client.js');
  const client = new ApolloClient(config, logger);
  client.healthCheck().then(console.log);
"

# List registered graphs (from Code Workspace)
node -e "
  const { listGraphs } = require('./dist/../aip-logic/register-graphs.js');
  console.log(listGraphs());
"
```

---

## Escalation Paths

| Team | When to Escalate | Contact |
|---|---|---|
| **Apollo** | Apollo health check fails, auth errors, route not found | Apollo on-call Slack: `#apollo-support` |
| **Striveworks** | Agent returns unexpected errors, agent timeout, model issues | Striveworks on-call: `#chariot-support` |
| **Foundry Platform** | Code Workspace issues, Ontology write failures, Streams issues | Foundry on-call: `#foundry-platform` |
| **Orchestration Layer** | Graph logic bugs, state corruption, deployment issues | This team's on-call rotation |

---

## Further Reading

- `docs/architecture.md` — System design and ADRs
- `docs/aip-logic-vs-orchestration.md` — Why this layer exists
- `docs/apollo-bridge.md` — Apollo integration and auth
- `README.md` — Project overview and glossary
