import { OpenAIResponses, supportedModels } from "@mozaik-ai/core";

export function createSupportedModels(apiKey?: string) {
  const luna = supportedModels.find((model) => model.specification.name === "gpt-6-luna");
  if (!luna) throw new Error("Core is missing gpt-6-luna");
  const endpoint = new OpenAIResponses(undefined, { apiKey });
  return [
    ...supportedModels,
    ...["gpt-6.2-sol", "gpt-6.1-terra"].map((name) => ({
      endpoint,
      specification: { ...luna.specification, name },
    })),
  ];
}
