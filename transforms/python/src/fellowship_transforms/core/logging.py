"""
Structured logging for Python transforms.

Provides a structlog-based logging setup that:
  - Outputs structured JSON in production (for Foundry log aggregation)
  - Outputs human-readable console logs in development
  - Includes standard context (service name, environment, timestamp)
  - Supports child loggers with bound context
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Dict, Optional

import structlog
from pythonjsonlogger import jsonlogger


def configure_logging(
    level: str = "INFO",
    structured: bool = False,
    service_name: str = "fellowship-transforms",
    environment: str = "dev",
) -> None:
    """
    Configure structured logging for Python transforms.

    Args:
        level: Minimum log level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        structured: If True, output JSON; if False, pretty console output.
        service_name: Service name included in all log entries.
        environment: Deployment environment tag.
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    if structured:
        # JSON output for production
        formatter = jsonlogger.JsonFormatter(
            fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S.%fZ",
        )
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)
        root_logger = logging.getLogger()
        root_logger.handlers.clear()
        root_logger.addHandler(handler)
        root_logger.setLevel(numeric_level)
    else:
        # Pretty console output for development
        logging.basicConfig(
            format="%(asctime)s [%(levelname)-7s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
            level=numeric_level,
            stream=sys.stdout,
        )

    # Configure structlog
    structlog.configure(
        processors=[
            # Add log level
            structlog.stdlib.add_log_level,
            # Add logger name
            structlog.stdlib.add_logger_name,
            # Add timestamp
            structlog.processors.TimeStamper(fmt="iso"),
            # Add stack info for exceptions
            structlog.processors.StackInfoRenderer(),
            # Format exceptions
            structlog.processors.format_exc_info,
            # Add standard context
            structlog.stdlib.add_extra_context_class,
            # Choose renderer
            structlog.dev.ConsoleRenderer()
            if not structured
            else structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # Bind standard context to all loggers
    structlog.contextvars.bind_contextvars(
        service=service_name,
        environment=environment,
    )


def get_logger(name: str, **bound_context: Any) -> structlog.BoundLogger:
    """
    Get a structured logger with the given name and optional bound context.

    Args:
        name: Logger name (typically __name__).
        **bound_context: Additional key-value pairs to bind to all log messages.

    Returns:
        A structlog BoundLogger instance.

    Example:
        >>> logger = get_logger(__name__, graph_name="triage")
        >>> logger.info("Transform started", batch_size=100)
    """
    logger = structlog.get_logger(name)
    if bound_context:
        logger = logger.bind(**bound_context)
    return logger
