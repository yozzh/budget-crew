import type { Tool } from "@mozaik-ai/core";
import { z } from "zod";

type FunctionTool = Extract<Tool, { type: "function" }>;
type WebSearchOptions = {
  mode: "stub" | "live";
  apiKey?: string;
  baseURL?: string;
  warn: (message: string) => void;
};

const searchArgs = z.strictObject({ query: z.string().trim().min(1) });
const responseSchema = z.object({
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      annotations: z.array(z.object({
        type: z.string(),
        title: z.string().optional(),
        url: z.string().optional(),
      })).optional(),
    })).optional(),
  })),
});

export const stubWebSearchResult = {
  status: "ok",
  summary: "Synthetic example: AirPods EUR 149.00 (€149.00) at https://shop.example/airpods. Not a live offer.",
  sources: [{ title: "Synthetic AirPods offer — EUR 149.00", url: "https://shop.example/airpods" }],
} as const;

function extractResult(body: unknown) {
  const { output } = responseSchema.parse(body);
  const lines: string[] = [];
  const sources: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const item of output) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type !== "output_text") continue;
      if (content.text?.trim()) lines.push(content.text.trim());
      for (const citation of content.annotations ?? []) {
        if (citation.type !== "url_citation" || !citation.title?.trim() || !citation.url?.trim()) continue;
        const url = citation.url.trim();
        if (sources.length === 3 || seen.has(url)) continue;
        seen.add(url);
        sources.push({ title: citation.title.trim(), url });
      }
    }
  }
  const summary = lines.join("\n");
  if (!summary) throw new Error("Web search returned no summary");
  return { status: "ok" as const, summary, sources };
}

/** Each instance is a single search attempt, including failures and concurrent calls. */
export function createWebSearchTool(options: WebSearchOptions): FunctionTool {
  let attempted = false;
  return {
    type: "function", name: "web_search", strict: true,
    description: "Find current purchase prices and sources. Search at most once; results can be unavailable. Stub results are synthetic, not live offers.",
    parameters: z.toJSONSchema(searchArgs),
    invoke: async (args: unknown) => {
      if (attempted) return { status: "limit" };
      attempted = true;
      let timer: NodeJS.Timeout | undefined;
      try {
        const { query } = searchArgs.parse(args);
        if (options.mode === "stub") return stubWebSearchResult;
        if (!options.apiKey) throw new Error("Web search credentials unavailable");
        const controller = new AbortController();
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Web search timed out"));
            controller.abort();
          }, 20_000);
        });
        const request = (async () => {
          const response = await fetch(`${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
            signal: controller.signal,
            body: JSON.stringify({
              model: "gpt-6.1-terra",
              tools: [{ type: "web_search" }],
              store: false,
              instructions: "Summarize current purchase prices in no more than 3 short lines. Quote prices in EUR and include source URLs. Do not invent offers.",
              input: query,
            }),
          });
          if (!response.ok) throw new Error("Web search request failed");
          return extractResult(await response.json());
        })();
        return await Promise.race([request, deadline]);
      } catch {
        options.warn("Web search unavailable.");
        return { status: "unavailable" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
