import { OpenAIResponses, supportedModels } from "@mozaik-ai/core";

const crewModels = ["gpt-6-luna", "gpt-6.2-sol", "gpt-6.1-terra"];

/** All crew models share one endpoint, so a base URL override (subscription proxy) covers every agent. */
export function createSupportedModels(apiKey?: string, baseURL?: string) {
  const luna = supportedModels.find((model) => model.specification.name === "gpt-6-luna");
  if (!luna) throw new Error("Core is missing gpt-6-luna");
  const endpoint = new OpenAIResponses(undefined, { apiKey, baseURL });
  return [
    ...supportedModels.filter((model) => !crewModels.includes(model.specification.name)),
    ...crewModels.map((name) => ({
      endpoint,
      specification: { ...luna.specification, name },
    })),
  ];
}
