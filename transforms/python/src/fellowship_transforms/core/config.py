"""
Transform-level configuration management.

Provides a Pydantic-based configuration model for Python transforms,
with support for loading from YAML files and environment variables.

Configuration resolution order (highest to lowest priority):
    1. Environment variables (prefixed with FELLOWSHIP_)
    2. YAML configuration file
    3. Default values
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Optional

import yaml
from pydantic import BaseModel, Field, field_validator


class FoundryConfig(BaseModel):
    """Foundry connection configuration for Python transforms."""

    base_url: str = Field(
        default="https://your-enrollment.palantirfoundry.com",
        description="Base URL of the Foundry enrollment",
    )
    token_env_var: str = Field(
        default="FOUNDRY_TOKEN",
        description="Environment variable name for the Foundry service token",
    )
    ontology_rid: str = Field(
        default="ri.ontology.main.ontology.agent-results",
        description="Foundry Ontology RID for agent results",
    )
    dataset_rid: str = Field(
        default="ri.foundry.main.dataset.graph-checkpoints",
        description="Foundry dataset RID for graph state persistence",
    )
    dataset_branch: str = Field(
        default="master",
        description="Foundry dataset branch for writes",
    )

    @property
    def token(self) -> Optional[str]:
        """Resolve the Foundry token from the environment."""
        return os.getenv(self.token_env_var)


class LoggingConfig(BaseModel):
    """Logging configuration for Python transforms."""

    level: str = Field(
        default="INFO",
        description="Log level: DEBUG, INFO, WARNING, ERROR",
    )
    structured: bool = Field(
        default=False,
        description="Whether to use structured JSON logging",
    )
    service_name: str = Field(
        default="fellowship-transforms",
        description="Service name for log context",
    )

    @field_validator("level", mode="before")
    @classmethod
    def validate_level(cls, v: str) -> str:
        """Normalize log level to uppercase."""
        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        upper = v.upper()
        if upper not in valid_levels:
            raise ValueError(f"Invalid log level: {v}. Must be one of {valid_levels}")
        return upper


class IngestConfig(BaseModel):
    """Configuration for the ingest transform."""

    source_path: str = Field(
        default="",
        description="Path to the source data (Foundry dataset path)",
    )
    output_ontology_rid: str = Field(
        default="ri.ontology.main.ontology.agent-results",
        description="Target Ontology RID for ingested objects",
    )
    batch_size: int = Field(
        default=100,
        ge=1,
        le=10000,
        description="Number of records to process per batch",
    )
    validate_schema: bool = Field(
        default=True,
        description="Whether to validate input against the ontology schema",
    )


class OutputConfig(BaseModel):
    """Configuration for the output transform."""

    target_dataset_rid: str = Field(
        default="ri.foundry.main.dataset.agent-results",
        description="Target dataset RID for writing results",
    )
    target_branch: str = Field(
        default="master",
        description="Target dataset branch",
    )
    write_mode: str = Field(
        default="append",
        description="Write mode: append, overwrite, or merge",
    )
    partition_by: list[str] = Field(
        default_factory=lambda: ["execution_date"],
        description="Partition columns for the output dataset",
    )

    @field_validator("write_mode", mode="before")
    @classmethod
    def validate_write_mode(cls, v: str) -> str:
        """Validate the write mode."""
        valid_modes = {"append", "overwrite", "merge"}
        if v not in valid_modes:
            raise ValueError(f"Invalid write mode: {v}. Must be one of {valid_modes}")
        return v


class TransformConfig(BaseModel):
    """Complete configuration for Python transforms."""

    environment: str = Field(
        default="dev",
        description="Deployment environment: dev, staging, or prod",
    )
    foundry: FoundryConfig = Field(default_factory=FoundryConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    ingest: IngestConfig = Field(default_factory=IngestConfig)
    output: OutputConfig = Field(default_factory=OutputConfig)

    @field_validator("environment", mode="before")
    @classmethod
    def validate_environment(cls, v: str) -> str:
        """Validate the environment name."""
        valid_envs = {"dev", "staging", "prod"}
        if v not in valid_envs:
            raise ValueError(f"Invalid environment: {v}. Must be one of {valid_envs}")
        return v


def load_config(config_path: Optional[str] = None) -> TransformConfig:
    """
    Load transform configuration from YAML file and environment variables.

    Resolution order:
        1. YAML config file (if provided and exists)
        2. Environment variables (FELLOWSHIP_* prefix)
        3. Default values

    Args:
        config_path: Optional path to a YAML configuration file.
            Defaults to FELLOWSHIP_CONFIG_PATH env var or 'configs/transforms.yaml'.

    Returns:
        A validated TransformConfig instance.

    Raises:
        FileNotFoundError: If the specified config file does not exist.
        ValueError: If the configuration is invalid.
    """
    config_data: Dict[str, Any] = {}

    # Determine config path
    resolved_path = config_path or os.getenv("FELLOWSHIP_CONFIG_PATH", "configs/transforms.yaml")

    # Load YAML if it exists
    yaml_path = Path(resolved_path)
    if yaml_path.exists():
        with open(yaml_path, "r") as f:
            yaml_data = yaml.safe_load(f)
            if yaml_data:
                config_data.update(yaml_data)

    # Override with environment variables
    env_overrides = _load_env_overrides()
    if env_overrides:
        _deep_merge(config_data, env_overrides)

    return TransformConfig(**config_data)


def _load_env_overrides() -> Dict[str, Any]:
    """Load configuration overrides from FELLOWSHIP_-prefixed env vars."""
    overrides: Dict[str, Any] = {}
    prefix = "FELLOWSHIP_"

    for key, value in os.environ.items():
        if key.startswith(prefix):
            # Remove prefix and split on double underscore for nesting
            config_key = key[len(prefix) :].lower()
            parts = config_key.split("__")

            # Handle simple scalar overrides
            if len(parts) == 1:
                overrides[parts[0]] = _coerce_value(value)
            else:
                # Nested override: FELLOWSHIP_LOGGING__LEVEL=DEBUG
                current = overrides
                for part in parts[:-1]:
                    if part not in current:
                        current[part] = {}
                    current = current[part]
                current[parts[-1]] = _coerce_value(value)

    return overrides


def _coerce_value(value: str) -> Any:
    """Coerce a string environment variable to the appropriate Python type."""
    # Boolean
    if value.lower() in ("true", "yes", "1"):
        return True
    if value.lower() in ("false", "no", "0"):
        return False

    # Integer
    try:
        return int(value)
    except ValueError:
        pass

    # Float
    try:
        return float(value)
    except ValueError:
        pass

    # Default to string
    return value


def _deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> None:
    """Deep merge override dict into base dict in-place."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
