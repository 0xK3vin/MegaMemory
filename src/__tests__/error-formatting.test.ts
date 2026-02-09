import { describe, it, expect } from "vitest";
import { formatError } from "../tools.js";

describe("formatError", () => {
  it("formats Error instances with MEGAMEMORY_ERROR prefix", () => {
    const error = new Error("Something went wrong");
    const result = formatError(error);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: Something went wrong");
    expect(result.isError).toBe(true);
  });

  it("formats non-Error objects with MEGAMEMORY_ERROR prefix", () => {
    const error = "String error message";
    const result = formatError(error);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: String error message");
    expect(result.isError).toBe(true);
  });

  it("formats numbers with MEGAMEMORY_ERROR prefix", () => {
    const error = 404;
    const result = formatError(error);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: 404");
    expect(result.isError).toBe(true);
  });

  it("formats null with MEGAMEMORY_ERROR prefix", () => {
    const result = formatError(null);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: null");
    expect(result.isError).toBe(true);
  });

  it("formats undefined with MEGAMEMORY_ERROR prefix", () => {
    const result = formatError(undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: undefined");
    expect(result.isError).toBe(true);
  });

  it("preserves error messages with special characters", () => {
    const error = new Error("Error: Database 'test.db' not found at /path/to/file");
    const result = formatError(error);

    expect(result.content[0].text).toBe("MEGAMEMORY_ERROR: Error: Database 'test.db' not found at /path/to/file");
    expect(result.isError).toBe(true);
  });

  it("always returns isError: true", () => {
    const error1 = new Error("Test");
    const error2 = "String error";
    const error3 = 123;

    expect(formatError(error1).isError).toBe(true);
    expect(formatError(error2).isError).toBe(true);
    expect(formatError(error3).isError).toBe(true);
  });

  it("always returns array with single content item", () => {
    const result1 = formatError(new Error("Test"));
    const result2 = formatError("String error");

    expect(result1.content).toHaveLength(1);
    expect(result2.content).toHaveLength(1);
  });
});
