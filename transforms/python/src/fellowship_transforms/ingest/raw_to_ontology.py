"""
Raw Source Data → Foundry Ontology Objects Transform.

This transform takes raw input data (typically from a Foundry dataset or
external source) and converts it into typed Ontology objects that can be
stored in the Foundry Ontology.

The transform:
  1. Reads raw records from a source dataset
  2. Validates each record against a Pydantic schema
  3. Maps records to Ontology object representations
  4. Batches records for efficient Ontology writes
  5. Returns the list of created Ontology object RIDs
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterator, List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from fellowship_transforms.core.config import TransformConfig, load_config
from fellowship_transforms.core.logging import get_logger

# ============================================================================
# Ontology Object Models
# ============================================================================


class AgentResultOntologyObject(BaseModel):
    """
    Pydantic model for an Agent Result Ontology object.

    Represents the output of a single agent execution within a graph run,
    mapped to the Foundry Ontology's AgentResult object type.
    """

    rid: str = Field(
        default_factory=lambda: f"ri.ontology.main.object.agent-result.{uuid4().hex}",
        description="Unique Ontology RID for this object",
    )
    execution_id: str = Field(
        ...,
        description="ULID of the parent graph execution",
    )
    graph_name: str = Field(
        ...,
        description="Name of the executed graph",
    )
    node_name: str = Field(
        ...,
        description="Name of the node that produced this result",
    )
    agent_name: str = Field(
        ...,
        description="Name of the Striveworks agent",
    )
    output: Dict[str, Any] = Field(
        default_factory=dict,
        description="Raw output from the agent",
    )
    duration_ms: int = Field(
        default=0,
        description="Execution duration in milliseconds",
    )
    retry_count: int = Field(
        default=0,
        description="Number of retry attempts",
    )
    success: bool = Field(
        default=True,
        description="Whether the agent execution succeeded",
    )
    error_message: Optional[str] = Field(
        default=None,
        description="Error message if execution failed",
    )
    started_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO 8601 timestamp of execution start",
    )
    completed_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO 8601 timestamp of execution completion",
    )
    ingested_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO 8601 timestamp of when this object was ingested",
    )


class ExecutionResultOntologyObject(BaseModel):
    """
    Pydantic model for an Execution Result Ontology object.

    Represents the final result of a graph execution, mapped to the
    Foundry Ontology's ExecutionResult object type.
    """

    rid: str = Field(
        default_factory=lambda: f"ri.ontology.main.object.execution-result.{uuid4().hex}",
        description="Unique Ontology RID for this object",
    )
    execution_id: str = Field(
        ...,
        description="ULID of the graph execution",
    )
    graph_name: str = Field(
        ...,
        description="Name of the executed graph",
    )
    status: str = Field(
        ...,
        description="Final execution status",
    )
    duration_ms: int = Field(
        default=0,
        description="Total execution duration in milliseconds",
    )
    completed_nodes: int = Field(
        default=0,
        description="Number of nodes that completed successfully",
    )
    failed_nodes: int = Field(
        default=0,
        description="Number of nodes that failed",
    )
    skipped_nodes: int = Field(
        default=0,
        description="Number of nodes that were skipped",
    )
    started_at: str = Field(
        ...,
        description="ISO 8601 timestamp of execution start",
    )
    completed_at: str = Field(
        ...,
        description="ISO 8601 timestamp of execution completion",
    )
    error_message: Optional[str] = Field(
        default=None,
        description="Error message if execution failed",
    )
    ingested_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="ISO 8601 timestamp of when this was ingested",
    )


# ============================================================================
# Transform
# ============================================================================


class RawToOntologyTransform:
    """
    Transforms raw execution results into Foundry Ontology objects.

    This transform is the bridge between the TypeScript orchestrator's
    execution output and Foundry's Ontology data model. It takes raw
    execution results and produces typed Ontology objects.

    Example:
        >>> transform = RawToOntologyTransform(config)
        >>> objects = transform.transform(raw_results)
        >>> print(f"Created {len(objects)} Ontology objects")
    """

    def __init__(self, config: Optional[TransformConfig] = None):
        """
        Initialize the transform.

        Args:
            config: Transform configuration. Loads defaults if not provided.
        """
        self.config = config or load_config()
        self.logger = get_logger(
            __name__,
            transform="RawToOntology",
            environment=self.config.environment,
        )

    def transform(
        self,
        raw_results: List[Dict[str, Any]],
    ) -> Dict[str, List[Any]]:
        """
        Transform raw execution results into Ontology objects.

        Args:
            raw_results: List of raw execution result dictionaries from
                the orchestrator's ExecutionResult output.

        Returns:
            Dict with two keys:
                - "agent_results": List of AgentResultOntologyObject
                - "execution_results": List of ExecutionResultOntologyObject
        """
        self.logger.info(
            "Starting raw-to-ontology transform",
            record_count=len(raw_results),
        )

        agent_results: List[AgentResultOntologyObject] = []
        execution_results: List[ExecutionResultOntologyObject] = []

        for batch in self._batch_records(raw_results, self.config.ingest.batch_size):
            for record in batch:
                # Create execution result object
                exec_obj = self._map_execution_result(record)
                execution_results.append(exec_obj)

                # Create agent result objects from traces
                for trace in record.get("traces", []):
                    if trace.get("result"):
                        agent_obj = self._map_agent_result(trace, record.get("execution_id", ""))
                        agent_results.append(agent_obj)

            self.logger.debug(
                "Batch processed",
                batch_size=len(batch),
                total_agent_results=len(agent_results),
                total_execution_results=len(execution_results),
            )

        self.logger.info(
            "Transform complete",
            agent_result_count=len(agent_results),
            execution_result_count=len(execution_results),
        )

        return {
            "agent_results": agent_results,
            "execution_results": execution_results,
        }

    def _map_execution_result(self, record: Dict[str, Any]) -> ExecutionResultOntologyObject:
        """Map a raw execution result record to an Ontology object."""
        return ExecutionResultOntologyObject(
            execution_id=record.get("executionId", ""),
            graph_name=record.get("graphName", ""),
            status=record.get("status", "UNKNOWN"),
            duration_ms=record.get("durationMs", 0),
            completed_nodes=len(record.get("finalState", {}).get("completedNodes", [])),
            failed_nodes=len(record.get("finalState", {}).get("failedNodes", [])),
            skipped_nodes=len(record.get("finalState", {}).get("skippedNodes", [])),
            started_at=record.get("startedAt", ""),
            completed_at=record.get("completedAt", ""),
            error_message=record.get("errorMessage"),
        )

    def _map_agent_result(
        self, trace: Dict[str, Any], execution_id: str
    ) -> AgentResultOntologyObject:
        """Map a node trace to an AgentResult Ontology object."""
        result = trace.get("result", {})
        return AgentResultOntologyObject(
            execution_id=execution_id,
            graph_name=trace.get("graphName", ""),
            node_name=trace.get("nodeName", trace.get("node_name", "")),
            agent_name=trace.get("agentName", trace.get("agent_name", "")),
            output=result.get("output", {}),
            duration_ms=result.get("durationMs", trace.get("durationMs", 0)),
            retry_count=result.get("retryCount", trace.get("retryCount", 0)),
            success=result.get("success", True),
            error_message=result.get("errorMessage") or trace.get("errorMessage"),
            started_at=result.get("startedAt", trace.get("startedAt", "")),
            completed_at=result.get("completedAt", trace.get("completedAt", "")),
        )

    @staticmethod
    def _batch_records(
        records: List[Dict[str, Any]], batch_size: int
    ) -> Iterator[List[Dict[str, Any]]]:
        """Yield records in batches of the given size."""
        for i in range(0, len(records), batch_size):
            yield records[i : i + batch_size]
