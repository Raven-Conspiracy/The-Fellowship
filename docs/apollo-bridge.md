# Apollo Bridge — Integration Details

> **Audience:** Engineers setting up Apollo connectivity and auth  
> **Status:** Living document  
> **Last Updated:** 2026-05

---

## Overview

**Apollo** is Palantir's deployment and service mesh platform. It provides the
transport layer between Foundry Code Workspaces and Striveworks Chariot agents.
The orchestrator communicates with Striveworks agents exclusively through
Apollo — it never calls Striveworks directly.

---

## Architecture

```
Orchestrator (Foundry Code Workspace)
        │
        │ HTTPS + Bearer Token
        ▼
┌───────────────────────────────────┐
│           PALANTIR APOLLO          │
│                                    │
│  ┌──────────────────────────────┐ │
│  │   Service Routes             │ │
│  │                              │ │
│  │  /striveworks/classify       │ │
│  │  /striveworks/analyze        │ │
│  │  /striveworks/summarize      │ │
│  │  /striveworks/escalate       │ │
│  │  ...                         │ │
│  │                              │ │
│  │  /health                     │ │
│  └──────────────────────────────┘ │
│                                    │
│  Features:                         │
│  • TLS termination                 │
│  • Auth (API key / mTLS)           │
│  • Rate limiting                   │
│  • Request logging                 │
│  • Service discovery               │
└───────────────────┬───────────────┘
                    │
                    │ gRPC or HTTPS
                    ▼
┌───────────────────────────────────┐
│      STRIVEWORKS CHARIOT          │
│                                    │
│  Agent: Classifier                 │
│  Agent: Analyzer                   │
│  Agent: Summarizer                 │
│  Agent: Escalator                  │
│  ...                               │
└───────────────────────────────────┘
```

---

## Authentication

### API Key Authentication (Current)

Apollo is configured to accept a Bearer token in the `Authorization` header:

```
Authorization: Bearer <APOLLO_TOKEN>
```

The token is:
- Set via the `APOLLO_TOKEN` environment variable
- Injected into every request by `ApolloClient`
- Rotated per Apollo's token lifecycle policy (typically 90 days)

### mTLS (Future)

For production, the team is evaluating mTLS as a stronger authentication
mechanism. This would involve:
- Client certificate issued by Apollo's PKI
- Mutual TLS handshake on every request
- No long-lived bearer tokens

The `ApolloClient` abstraction supports swapping the auth mechanism without
changing any calling code.

---

## Agent Registry Configuration

The agent registry maps logical agent names to Apollo routes. It is loaded
from a YAML file:

```yaml
# configs/dev.yaml
agents:
  - name: classifier
    route: /striveworks/classify
    timeout_ms: 30000
    max_retries: 3
    backoff_base_ms: 500
    description: "Classifies incoming incidents by type and severity"

  - name: analyzer
    route: /striveworks/analyze
    timeout_ms: 60000          # Analyzer may take longer
    max_retries: 2
    backoff_base_ms: 1000
    description: "Performs deep analysis of classified incidents"

  - name: summarizer
    route: /striveworks/summarize
    timeout_ms: 30000
    max_retries: 2
    description: "Generates human-readable summaries of analysis"

  - name: escalator
    route: /striveworks/escalate
    timeout_ms: 15000
    max_retries: 5             # Escalation is critical — retry aggressively
    backoff_base_ms: 250
    description: "Creates escalation tickets for low-confidence results"

  - name: fetcher
    route: /striveworks/fetch
    timeout_ms: 45000
    max_retries: 3

  - name: normalizer
    route: /striveworks/normalize
    timeout_ms: 20000

  - name: merger
    route: /striveworks/merge
    timeout_ms: 30000

  - name: validator
    route: /striveworks/validate
    timeout_ms: 15000

  - name: gatherer
    route: /striveworks/gather
    timeout_ms: 60000
    max_retries: 2

  - name: formatter
    route: /striveworks/format
    timeout_ms: 30000

  - name: deliverer
    route: /striveworks/deliver
    timeout_ms: 15000
    condition: "state.format.approved === true"

defaults:
  timeout_ms: 20000
  max_retries: 2
  backoff_base_ms: 500
```

### Route Convention

Apollo routes for Striveworks agents follow the pattern:

```
/striveworks/<agent-name>
```

Where `<agent-name>` is the lowercase, hyphenated agent identifier (e.g.,
`classify`, `analyze`, `summarize`).

### Per-Agent Configuration

Each agent entry supports:

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | (required) | Logical agent name |
| `route` | `string` | (required) | Apollo route path |
| `timeout_ms` | `number` | `20000` | Request timeout in milliseconds |
| `max_retries` | `number` | `2` | Maximum retry attempts |
| `backoff_base_ms` | `number` | `500` | Base backoff delay in ms |
| `input_schema` | `object` | — | Zod schema for agent input |
| `output_schema` | `object` | — | Zod schema for agent output |
| `description` | `string` | — | Human-readable description |

---

## Request/Response Wire Format

### Apollo Request

The `ApolloClient` sends a POST request with a JSON body:

```http
POST /striveworks/classify HTTP/1.1
Host: apollo.palantirfoundry.com
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Correlation-Id: 01JABC123DEF456
User-Agent: The-Fellowship-Orchestrator/0.1.0

{
  "incident_id": "01JXYZ789",
  "raw_text": "Database replication lag on us-east-1",
  "graph_context": {
    "graphId": "incident-triage",
    "executionId": "01JEXEC123",
    "nodeId": "classify",
    "agentName": "classifier"
  }
}
```

### Apollo Response (Success)

```json
{
  "status": "success",
  "requestId": "ap-req-abc123",
  "data": {
    "category": "database",
    "confidence": 0.92,
    "tags": ["replication", "lag", "us-east-1"]
  },
  "metadata": {
    "model_version": "classifier-v3.2.1",
    "inference_time_ms": 1450,
    "token_count": 342
  }
}
```

### Apollo Response (Agent Error)

```json
{
  "status": "error",
  "requestId": "ap-req-abc123",
  "error": {
    "code": "AGENT_TIMEOUT",
    "message": "Agent exceeded maximum processing time of 30000ms",
    "detail": {
      "timeout_ms": 30000,
      "elapsed_ms": 31250
    }
  }
}
```

### Apollo Response (Infrastructure Error)

HTTP status codes outside the 2xx range are mapped to `DomainError` subtypes:

| HTTP Status | Error Type | Retryable? |
|---|---|---|
| 401, 403 | `AuthenticationError` | ❌ No |
| 422 | `ApolloError` (validation) | ❌ No |
| 429 | `ApolloError` (rate-limited) | ✅ Yes |
| 500-599 | `ApolloError` (server error) | ✅ Yes |
| Timeout / no response | `TimeoutError` / `NetworkError` | ✅ Yes |

---

## Circuit Breaker Configuration

The circuit breaker protects Apollo from overload by failing fast when the
upstream is unhealthy.

```typescript
// In ApolloEndpointConfig
{
  circuitBreaker: {
    failureThreshold: 5,     // Open after 5 consecutive failures
    resetTimeoutMs: 30_000,  // Try HALF_OPEN after 30 seconds
  }
}
```

| Parameter | Default | Description |
|---|---|---|
| `failureThreshold` | `5` | Consecutive failures before opening |
| `resetTimeoutMs` | `30000` | Time before transitioning OPEN → HALF_OPEN |

### Circuit Breaker States

```
         ┌─────────┐
    ┌───►│ CLOSED  │◄──────────────┐
    │    └────┬─────┘               │
    │         │                     │
    │    failures >=                │ success
    │    threshold                  │
    │         │                     │
    │         ▼                     │
    │    ┌─────────┐    timeout    ┌─┴────────┐
    │    │  OPEN   │──────────────►│ HALF_OPEN │
    │    └─────────┘               └─────┬─────┘
    │                                    │
    │                              failure (re-open)
    └────────────────────────────────────┘
```

---

## Health Check

The `ApolloClient.healthCheck()` method performs a lightweight check:

```http
GET /health HTTP/1.1
Host: apollo.palantirfoundry.com
Authorization: Bearer <token>
X-Correlation-Id: 01J...
```

A 2xx response indicates Apollo is reachable. This does **not** guarantee
individual Striveworks agents are healthy — only that the Apollo service mesh
is responding.

For per-agent health, a future enhancement could call each agent's `/health`
endpoint (if Striveworks exposes one).

---

## Retry Strategy

Retries use exponential backoff with **full jitter**:

```
delay = min(base * 2^(attempt-1), maxBackoffMs) * random(0.5, 1.0)
```

| Attempt | Base 500ms | Base 1000ms |
|---|---|---|
| 1 | 0ms (initial call) | 0ms |
| 2 | 250–500ms | 500–1000ms |
| 3 | 500–1000ms | 1000–2000ms |
| 4 | 1000–2000ms | 2000–4000ms |
| 5 | 2000–4000ms | 4000–8000ms |

Retries are applied at two levels:
1. **`axios-retry`** in `ApolloClient` — retries on network errors, 5xx, 429
2. **`AgentExecutor`** per-node retry loop — retries across all error types
   that are classified as retryable

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APOLLO_BASE_URL` | ✅ | Base URL for Apollo (e.g., `https://apollo.palantirfoundry.com`) |
| `APOLLO_TOKEN` | ✅ | Bearer token for Apollo authentication |
| `APOLLO_TIMEOUT_MS` | ❌ | Default request timeout (default: `30000`) |

---

## Troubleshooting

### 401 / 403 Authentication Errors
- Check `APOLLO_TOKEN` is set and not expired
- Verify the token has access to the requested route
- Check Apollo's token management console for rotation status

### Timeout Errors
- Increase `timeout_ms` for the specific agent in the registry YAML
- Check if the Striveworks agent is experiencing high latency
- Verify Apollo's network path to Striveworks

### Circuit Breaker Open
- Check Apollo health endpoint manually: `curl -H "Authorization: Bearer $APOLLO_TOKEN" $APOLLO_BASE_URL/health`
- Review recent error logs for patterns
- If Apollo is healthy, manually reset the circuit breaker: `client.resetCircuitBreaker()`

### Rate Limiting (429)
- Reduce graph parallelism
- Increase `backoff_base_ms` for the affected agent
- Contact Apollo team about rate limit quotas

---

## Further Reading

- `docs/architecture.md` — ADR-005 (retry), ADR-006 (circuit breaker)
- `docs/runbook.md` — Operational procedures for Apollo issues
- `orchestrator/src/adapters/apollo/apollo-client.ts` — Implementation
- `orchestrator/src/adapters/apollo/apollo-adapter.ts` — Anti-corruption layer
