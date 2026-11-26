import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebSearchTool, stubWebSearchResult } from "./web-search.js";

const network = vi.fn();
const summary = "AirPods EUR 149.00 at https://shop.example/airpods";
const source = { title: "AirPods offer", url: "https://shop.example/airpods" };
const body = {
  output: [{
    type: "message",
    content: [{ type: "output_text", text: summary, annotations: [{ type: "url_citation", ...source }] }],
  }],
};

function response(value: unknown = body) {
  return { ok: true, json: async () => value };
}

beforeEach(() => {
  network.mockReset();
  network.mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", network);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web_search", () => {
  it("returns the synthetic fixture without network access and limits later calls", async () => {
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "stub", warn });
    expect(tool).toMatchObject({ type: "function", name: "web_search", strict: true });
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: { query: { type: "string", minLength: 1 } },
    });
    expect(await tool.invoke({ query: "AirPods current price" })).toEqual(stubWebSearchResult);
    expect(stubWebSearchResult).toMatchObject({ status: "ok", summary: expect.stringContaining("€149.00") });
    expect(stubWebSearchResult.summary).toContain("Synthetic");
    expect(new URL(stubWebSearchResult.sources[0].url).hostname).toMatch(/\.example$/);
    expect(await tool.invoke({ query: "another query" })).toEqual({ status: "limit" });
    expect(network).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { query: 149 },
    { query: "" },
    { query: "   " },
    { query: "AirPods", extra: true },
  ])("validates strict arguments before any network access: %j", async (args) => {
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "live", apiKey: "secret-key", warn });
    expect(await tool.invoke(args)).toEqual({ status: "unavailable" });
    expect(await tool.invoke({ query: "valid retry" })).toEqual({ status: "limit" });
    expect(network).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["Web search unavailable."]]);
  });

  it.each([
    { baseURL: undefined, endpoint: "https://api.openai.com/v1/responses" },
    { baseURL: "https://provider.example/custom/v1///", endpoint: "https://provider.example/custom/v1/responses" },
  ])("posts one private Responses request to $endpoint", async ({ baseURL, endpoint }) => {
    vi.useFakeTimers();
    network.mockResolvedValue(response());
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "live", apiKey: "secret-key", baseURL, warn });
    expect(await tool.invoke({ query: "  AirPods current price  " })).toEqual({ status: "ok", summary, sources: [source] });
    expect(network).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret-key" },
      signal: expect.any(AbortSignal),
      body: expect.any(String),
    });
    const request = JSON.parse(network.mock.calls[0]![1].body);
    expect(request).toEqual({
      model: "gpt-6.1-terra",
      reasoning: { effort: "low" },
      tools: [{ type: "web_search", search_context_size: "low" }],
      store: false,
      instructions: expect.any(String),
      input: "AirPods current price",
    });
    expect(request.instructions).toContain("no more than 3 short lines");
    expect(request.instructions).toContain("EUR");
    expect(request.instructions).toContain("URLs");
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("extracts only message output_text and deduplicates citations by URL, capped at three", async () => {
    const second = { title: "Second shop", url: "https://second.example/airpods" };
    const third = { title: "Third shop", url: "https://third.example/airpods" };
    network.mockResolvedValue(response({
      output_text: "Ignore the top-level convenience text",
      output: [
        { type: "web_search_call", content: [{ type: "output_text", text: "Ignore non-message output" }] },
        {
          type: "message",
          content: [
            { type: "refusal", text: "Ignore non-output_text content" },
            {
              type: "output_text", text: "  First short line.  ",
              annotations: [
                { type: "file_citation", title: "Not a URL citation", url: "https://ignored.example" },
                { type: "url_citation", ...source },
                { type: "url_citation", title: "Duplicate title", url: source.url },
                { type: "url_citation", title: "Missing URL" },
                { type: "url_citation", url: "https://untitled.example" },
              ],
            },
          ],
        },
        {
          type: "message",
          content: [{
            type: "output_text", text: "Second short line.",
            annotations: [
              { type: "url_citation", ...second },
              { type: "url_citation", ...third },
              { type: "url_citation", title: "Fourth shop", url: "https://fourth.example/airpods" },
            ],
          }],
        },
      ],
    }));
    const warn = vi.fn();
    expect(await createWebSearchTool({ mode: "live", apiKey: "secret-key", warn }).invoke({ query: "AirPods" }))
      .toEqual({ status: "ok", summary: "First short line.\nSecond short line.", sources: [source, second, third] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("limits concurrent calls immediately while independent instances each get one attempt", async () => {
    network.mockResolvedValue(response());
    const warn = vi.fn();
    const firstTool = createWebSearchTool({ mode: "live", apiKey: "secret-key", warn });
    const otherTool = createWebSearchTool({ mode: "live", apiKey: "secret-key", warn });
    const first = firstTool.invoke({ query: "first" });
    const concurrent = firstTool.invoke({ query: "concurrent" });
    const independent = otherTool.invoke({ query: "independent" });
    expect(await concurrent).toEqual({ status: "limit" });
    expect(await Promise.all([first, independent])).toEqual([
      { status: "ok", summary, sources: [source] },
      { status: "ok", summary, sources: [source] },
    ]);
    expect(await firstTool.invoke({ query: "later" })).toEqual({ status: "limit" });
    expect(await otherTool.invoke({ query: "later" })).toEqual({ status: "limit" });
    expect(network).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["fetch", "response body"])("aborts and settles at 35 seconds even when %s ignores abort", async (stage) => {
    vi.useFakeTimers();
    const hung = new Promise<never>(() => {});
    if (stage === "fetch") network.mockReturnValue(hung);
    else network.mockResolvedValue({ ok: true, json: () => hung });
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "live", apiKey: "secret-key", warn });
    const result = tool.invoke({ query: "private query" });
    const signal = (network.mock.calls[0]![1] as RequestInit).signal!;
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(signal.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ status: "unavailable" });
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(true);
    expect(await tool.invoke({ query: "retry" })).toEqual({ status: "limit" });
    expect(network).toHaveBeenCalledOnce();
    expect(warn.mock.calls).toEqual([["Web search unavailable."]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["transport", "http", "invalid-json", "malformed-body", "empty-summary"])("returns unavailable without exposing private %s errors", async (failure) => {
    vi.useFakeTimers();
    const privateDetails = "private query secret-key https://provider.example/internal";
    const json = vi.fn(async () => {
      if (failure === "invalid-json") throw new SyntaxError(privateDetails);
      if (failure === "malformed-body") return { error: { message: privateDetails } };
      if (failure === "empty-summary") return { output: [{ type: "message", content: [{ type: "output_text", text: " " }] }] };
      return body;
    });
    if (failure === "transport") network.mockRejectedValue(new Error(privateDetails));
    else network.mockResolvedValue({ ok: failure !== "http", status: 503, json });
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "live", apiKey: "secret-key", baseURL: "https://provider.example", warn });
    expect(await tool.invoke({ query: "private query" })).toEqual({ status: "unavailable" });
    expect(await tool.invoke({ query: "retry" })).toEqual({ status: "limit" });
    expect(network).toHaveBeenCalledOnce();
    if (failure === "http") expect(json).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["Web search unavailable."]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns unavailable without network access when live credentials are absent", async () => {
    const warn = vi.fn();
    const tool = createWebSearchTool({ mode: "live", warn });
    expect(await tool.invoke({ query: "AirPods" })).toEqual({ status: "unavailable" });
    expect(await tool.invoke({ query: "retry" })).toEqual({ status: "limit" });
    expect(network).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["Web search unavailable."]]);
  });
});
