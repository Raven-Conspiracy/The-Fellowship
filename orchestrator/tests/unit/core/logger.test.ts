/**
 * Core Logger — Unit Tests
 *
 * Tests for structured logging: log level filtering, child context
 * propagation, and mock logger assertions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMockLogger } from "../../mocks/logger.mock.js";
import type { MockLogger, LogEntry } from "../../mocks/logger.mock.js";

describe("Logger", () => {
  let logger: MockLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe("log levels", () => {
    it("should log at debug level", () => {
      logger.debug("debug message");
      expect(logger.getLogsAtLevel("debug")).toHaveLength(1);
      expect(logger.getLogsAtLevel("debug")[0]!.message).toBe("debug message");
    });

    it("should log at info level", () => {
      logger.info("info message");
      expect(logger.getLogsAtLevel("info")).toHaveLength(1);
      expect(logger.getLogsAtLevel("info")[0]!.message).toBe("info message");
    });

    it("should log at warn level", () => {
      logger.warn("warn message");
      expect(logger.getLogsAtLevel("warn")).toHaveLength(1);
      expect(logger.getLogsAtLevel("warn")[0]!.message).toBe("warn message");
    });

    it("should log at error level", () => {
      logger.error("error message");
      expect(logger.getLogsAtLevel("error")).toHaveLength(1);
      expect(logger.getLogsAtLevel("error")[0]!.message).toBe("error message");
    });
  });

  describe("structured context", () => {
    it("should include context object with message", () => {
      logger.info({ userId: "123", action: "test" }, "User action");
      const entry = logger.getLogsAtLevel("info")[0]!;
      expect(entry.message).toBe("User action");
      expect(entry.context).toHaveProperty("userId", "123");
      expect(entry.context).toHaveProperty("action", "test");
    });

    it("should support message-only calls (no context)", () => {
      logger.info("simple message");
      const entry = logger.getLogsAtLevel("info")[0]!;
      expect(entry.message).toBe("simple message");
      expect(entry.context).toBeDefined();
    });

    it("should include a timestamp", () => {
      logger.info("timed message");
      const entry = logger.getLogsAtLevel("info")[0]!;
      expect(entry.timestamp).toBeDefined();
      expect(() => new Date(entry.timestamp)).not.toThrow();
    });
  });

  describe("child loggers", () => {
    it("should create a child logger with merged context", () => {
      const child = logger.child({ component: "TestComponent" }) as MockLogger;
      child.info("child message");

      const entry = child.getLogsAtLevel("info")[0]!;
      expect(entry.message).toBe("child message");
      expect(entry.context).toHaveProperty("component", "TestComponent");
    });

    it("should not pollute parent logger with child context", () => {
      const child = logger.child({ component: "Child" }) as MockLogger;
      child.info("child message");

      const parentLogs = logger.getLogs();
      expect(parentLogs).toHaveLength(0); // Parent unchanged
    });

    it("should support nested children", () => {
      const child1 = logger.child({ layer: "1" }) as MockLogger;
      const child2 = child1.child({ layer2: "2" }) as unknown as MockLogger;
      child2.info("nested");

      const entry = child2.getLogsAtLevel("info")[0]!;
      expect(entry.context).toHaveProperty("layer", "1");
      expect(entry.context).toHaveProperty("layer2", "2");
    });
  });

  describe("log retrieval helpers", () => {
    it("should getLogsContaining find messages with substring", () => {
      logger.info("user logged in");
      logger.info("user logged out");
      logger.info("system restart");

      const userLogs = logger.getLogsContaining("user");
      expect(userLogs).toHaveLength(2);
    });

    it("should hasLog check level and predicate", () => {
      logger.error({ code: "ERR_001" }, "critical failure");

      expect(logger.hasLog("error", (e) => e.message.includes("critical"))).toBe(true);
      expect(logger.hasLog("info", () => true)).toBe(false);
    });

    it("should clearLogs remove all entries", () => {
      logger.info("msg1");
      logger.info("msg2");
      expect(logger.getLogs()).toHaveLength(2);

      logger.clearLogs();
      expect(logger.getLogs()).toHaveLength(0);
    });
  });

  describe("vitest mock functions", () => {
    it("should track calls through vi.fn", () => {
      logger.info("call 1");
      logger.info("call 2");

      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledWith("call 1");
      expect(logger.info).toHaveBeenCalledWith("call 2");
    });

    it("should support toHaveBeenCalledWith for context objects", () => {
      logger.error({ err: new Error("test") }, "An error occurred");
      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        "An error occurred",
      );
    });

    it("should reset properly", () => {
      logger.info("test");
      logger.reset();
      expect(logger.getLogs()).toHaveLength(0);
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
