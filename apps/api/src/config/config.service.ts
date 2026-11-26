import { Injectable } from "@nestjs/common";
import { z } from "zod";

const optionalKey = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

export const configSchema = z.object({
  INFERENCE: z.enum(["stub", "live"]).default("stub"),
  PUBLIC_DEMO: z.preprocess(
    (value) => value === "true" ? true : value === "false" ? false : value,
    z.boolean().default(false),
  ),
  LIVE_LIMIT_PER_IP_PER_HOUR: z.coerce.number().int().positive().default(10),
  LIVE_LIMIT_PER_DAY: z.coerce.number().int().positive().default(300),
  OPENAI_API_KEY: optionalKey,
  // OpenAI-compatible Responses endpoint, e.g. a local subscription proxy; unset means api.openai.com.
  OPENAI_BASE_URL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.url().optional(),
  ),
  MOZAIK_API_KEY: optionalKey,
  MOZAIK_PROJECT_ID: optionalKey,
  CENTRIFUGO_API_URL: z.url().default("http://127.0.0.1:8000/api"),
  CENTRIFUGO_API_KEY: optionalKey,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  APP_VERSION: z.string().trim().min(1).default("dev"),
}).superRefine((env, context) => {
  if (env.INFERENCE === "live" && !env.OPENAI_API_KEY) {
    context.addIssue({
      code: "custom",
      path: ["OPENAI_API_KEY"],
      message: "OPENAI_API_KEY is required when INFERENCE=live",
    });
  }
});

export type ConfigEnv = z.infer<typeof configSchema>;

@Injectable()
export class ConfigService {
  readonly env: ConfigEnv = configSchema.parse(process.env);
}
