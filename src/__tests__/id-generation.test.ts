import { describe, it, expect } from "vitest";
import { makeId } from "../tools.js";

describe("makeId", () => {
  it("converts a simple name to a slug", () => {
    expect(makeId("MCP Server")).toBe("mcp-server");
  });

  it("converts underscores to hyphens", () => {
    expect(makeId("my_cool_feature")).toBe("my-cool-feature");
  });

  it("converts spaces to hyphens", () => {
    expect(makeId("Web Explorer")).toBe("web-explorer");
  });

  it("strips special characters", () => {
    expect(makeId("Hello, World! (v2)")).toBe("hello-world-v2");
  });

  it("collapses multiple hyphens", () => {
    expect(makeId("foo---bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    expect(makeId("--leading-trailing--")).toBe("leading-trailing");
  });

  it("handles mixed underscores, spaces, and special chars", () => {
    expect(makeId("Init Command — Setup")).toBe("init-command-setup");
  });

  it("lowercases everything", () => {
    expect(makeId("CamelCaseInput")).toBe("camelcaseinput");
  });

  it("prefixes with parent ID when provided", () => {
    expect(makeId("Tool Registration", "mcp-server")).toBe(
      "mcp-server/tool-registration"
    );
  });

  it("handles parent ID with nested slug", () => {
    expect(makeId("Search Feature", "web-explorer")).toBe(
      "web-explorer/search-feature"
    );
  });

  it("returns empty string for input with only special chars", () => {
    expect(makeId("!!!")).toBe("");
  });

  it("handles numeric input", () => {
    expect(makeId("version 2")).toBe("version-2");
  });
});
