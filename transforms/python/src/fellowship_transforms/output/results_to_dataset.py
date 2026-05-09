"""
Orchestration Results → Foundry Dataset Transform.

This transform takes the final output of the TypeScript orchestrator
(an ExecutionResult) and writes it to a Foundry dataset for persistence,
auditing, and downstream analysis.

The transform:
  1. Receives execution results (from the orchestrator or a stream)
  2. Flattens the result into a tabular format suitable for Foundry datasets
  3. Validates the flattened records against a schema
  4. Writes records to the target Foundry dataset with appropriate partitioning
  5. Returns a summary of the write operation
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from fellowship_transforms.core.config import TransformConfig, load_config
from fellowship_transforms.core.logging import get_logger

# ============================================================================
# Dataset Record Models
# ============================================================================


class ExecutionResultRecord(BaseModel):
    """A single row in the execution results dataset."""

    execution_id: str = Field(..., description="ULID of the graph execution")
    graph_name: str = Field(..., description="Name of the executed graph")
    status: str = Field(..., description="Final execution status")
    duration_ms: int = Field(0, description="Total duration in milliseconds")
    completed_nodes: int = Field(0, description="Number of completed nodes")
    failed_nodes: int = Field(0, description="Number of failed nodes")
    skipped_nodes: int = Field(0, description="Number of skipped nodes")
    total_nodes: int = Field(0, description="Total nodes in the graph")
    started_at: str = Field(..., description="ISO 8601 execution start timestamp")
    completed_at: str = Field(..., description="ISO 8601 execution end timestamp")
    error_message: Optional[str] = Field(None, description="Error message if failed")
    input_summary: str = Field("", description="Summary of the input payload")
    execution_date: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        description="Date partition key",
    )
    written_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="When this record was written",
    )


class AgentResultRecord(BaseModel):
    """A single row in the agent results dataset."""

    execution_id: str = Field(..., description="Parent execution ULID")
    graph_name: str = Field(..., description="Name of the graph")
    node_name: str = Field(..., description="Name of the node")
    agent_name: str = Field(..., description="Name of the Striveworks agent")
    agent_success: bool = Field(True, description="Whether the agent call succeeded")
    agent_duration_ms: int = Field(0, description="Agent execution duration")
    agent_retry_count: int = Field(0, description="Number of retry attempts")
    agent_error_message: Optional[str] = Field(None, description="Agent error message")
    agent_output_keys: str = Field("", description="Comma-separated output keys")
    node_started_at: str = Field("", description="Node start timestamp")
    node_completed_at: str = Field("", description="Node completion timestamp")
    execution_date: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        description="Date partition key",
    )
    written_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
        description="When this record was written",
    )


# ============================================================================
# Write Summary
# ============================================================================


class WriteSummary(BaseModel):
    """Summary of a dataset write operation."""

    dataset_rid: str = Field(..., description="Target dataset RID")
    branch: str = Field("master", description="Target dataset branch")
    write_mode: str = Field("append", description="Write mode used")
    execution_records_written: int = Field(0)
    agent_records_written: int = Field(0)
    total_records_written: int = Field(0)
    errors: List[str] = Field(default_factory=list)
    written_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(),
    )


# ============================================================================
# Transform
# ============================================================================


class ResultsToDatasetTransform:
    """
    Writes orchestration execution results to Foundry datasets.

    This transform is the final step in the pipeline — it takes the
    output of the orchestrator and persists it into Foundry datasets
    for audit trails, dashboards, and downstream analysis.

    Example:
        >>> transform = ResultsToDatasetTransform(config)
        >>> summary = transform.write_results(execution_result)
        >>> print(f"Wrote {summary.total_records_written} records")
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
            transform="ResultsToDataset",
            environment=self.config.environment,
        )

    def write_results(
        self,
        execution_result: Dict[str, Any],
    ) -> WriteSummary:
        """
        Write a single execution result to the target datasets.

        Args:
            execution_result: An ExecutionResult dictionary from the orchestrator.

        Returns:
            A WriteSummary describing what was written.
        """
        summary = WriteSummary(
            dataset_rid=self.config.output.target_dataset_rid,
            branch=self.config.output.target_branch,
            write_mode=self.config.output.write_mode,
        )

        try:
            # Flatten the execution result into dataset records
            exec_record = self._flatten_execution_result(execution_result)
            agent_records = self._flatten_agent_results(execution_result)

            self.logger.info(
                "Writing results to dataset",
                execution_id=execution_result.get("executionId", "unknown"),
                execution_record=exec_record.model_dump(),
                agent_record_count=len(agent_records),
            )

            # In a real Foundry environment, these would call the Foundry
            # Dataset API to write the records. Here we simulate the write.
            summary.execution_records_written = 1
            summary.agent_records_written = len(agent_records)
            summary.total_records_written = 1 + len(agent_records)

        except Exception as e:
            self.logger.error(
                "Failed to write results to dataset",
                error=str(e),
                execution_id=execution_result.get("executionId", "unknown"),
            )
            summary.errors.append(str(e))

        return summary

    def write_batch_results(
        self,
        execution_results: List[Dict[str, Any]],
    ) -> WriteSummary:
        """
        Write multiple execution results to the target datasets in batch.

        Args:
            execution_results: List of ExecutionResult dictionaries.

        Returns:
            A WriteSummary describing what was written.
        """
        summary = WriteSummary(
            dataset_rid=self.config.output.target_dataset_rid,
            branch=self.config.output.target_branch,
            write_mode=self.config.output.write_mode,
        )

        all_exec_records: List[ExecutionResultRecord] = []
        all_agent_records: List[AgentResultRecord] = []

        for result in execution_results:
            try:
                all_exec_records.append(self._flatten_execution_result(result))
                all_agent_records.extend(self._flatten_agent_results(result))
            except Exception as e:
                self.logger.error(
                    "Failed to flatten result",
                    execution_id=result.get("executionId", "unknown"),
                    error=str(e),
                )
                summary.errors.append(
                    f"Flatten error for {result.get('executionId', 'unknown')}: {e}"
                )

        self.logger.info(
            "Writing batch results to dataset",
            execution_count=len(execution_results),
            execution_records=len(all_exec_records),
            agent_records=len(all_agent_records),
        )

        # In a real Foundry environment, these would call Foundry's API.
        summary.execution_records_written = len(all_exec_records)
        summary.agent_records_written = len(all_agent_records)
        summary.total_records_written = len(all_exec_records) + len(all_agent_records)

        return summary

    def _flatten_execution_result(self, result: Dict[str, Any]) -> ExecutionResultRecord:
        """Flatten an ExecutionResult into a dataset row."""
        final_state = result.get("finalState", {})

        # Build a brief input summary
        input_data = result.get("input", {})
        input_summary = ", ".join(list(input_data.keys())[:10])

        return ExecutionResultRecord(
            execution_id=result.get("executionId", ""),
            graph_name=result.get("graphName", ""),
            status=result.get("status", "UNKNOWN"),
            duration_ms=result.get("durationMs", 0),
            completed_nodes=len(final_state.get("completedNodes", [])),
            failed_nodes=len(final_state.get("failedNodes", [])),
            skipped_nodes=len(final_state.get("skippedNodes", [])),
            total_nodes=(
                len(final_state.get("completedNodes", []))
                + len(final_state.get("failedNodes", []))
                + len(final_state.get("skippedNodes", []))
            ),
            started_at=result.get("startedAt", ""),
            completed_at=result.get("completedAt", ""),
            error_message=result.get("errorMessage"),
            input_summary=input_summary,
        )

    def _flatten_agent_results(self, result: Dict[str, Any]) -> List[AgentResultRecord]:
        """Flatten node traces into agent result dataset rows."""
        records: List[AgentResultRecord] = []
        traces = result.get("traces", [])

        for trace in traces:
            agent_result = trace.get("result", {})

            # Determine output keys
            output = agent_result.get("output", {})
            output_keys = ", ".join(list(output.keys())[:20])

            records.append(
                AgentResultRecord(
                    execution_id=result.get("executionId", ""),
                    graph_name=result.get("graphName", ""),
                    node_name=trace.get("nodeName", ""),
                    agent_name=trace.get("agentName", ""),
                    agent_success=agent_result.get("success", trace.get("status") == "COMPLETED"),
                    agent_duration_ms=agent_result.get("durationMs", trace.get("durationMs", 0)),
                    agent_retry_count=agent_result.get("retryCount", trace.get("retryCount", 0)),
                    agent_error_message=agent_result.get("errorMessage")
                    or trace.get("errorMessage"),
                    agent_output_keys=output_keys,
                    node_started_at=trace.get("startedAt", ""),
                    node_completed_at=trace.get("completedAt", ""),
                )
            )

        return records
