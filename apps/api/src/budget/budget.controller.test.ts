import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { StateResponse, StateEnvelope } from "@budget-crew/shared";
import { BudgetController } from "./budget.controller.js";
import { BudgetStore } from "./budget.store.js";
import { CentrifugoPublisher } from "../realtime/centrifugo.publisher.js";

const publications: unknown[] = [];
@Module({ controllers: [BudgetController], providers: [BudgetStore, {
  provide: CentrifugoPublisher,
  useValue: { publish: async (channel: string, data: unknown) => { publications.push({ channel, data }); } },
}] })
class TestModule {}

let app: INestApplication;
const base = "http://127.0.0.1:25181/api";
beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(25181, "127.0.0.1");
});
afterAll(async () => { await app?.close(); });

it("GET fresh seed matches the contract; reset restores it and publishes state.reset", async () => {
  const response = await fetch(`${base}/state`);
  expect(response.status).toBe(200);
  const initial = StateResponse.parse(await response.json());
  expect(initial.periods.filter(period => period.status === "open")).toHaveLength(1);
  expect(initial.periods.filter(period => period.status === "closed")).toHaveLength(5);
  expect(initial.profile.name).toBe("Alex");
  const store = app.get(BudgetStore);
  for (let index = 0; index < 55; index++) store.beginRequest(`req-${index}`, "purchase", "Demo");
  const withRequests = StateResponse.parse(await (await fetch(`${base}/state`)).json());
  expect(Object.keys(withRequests.requests)).toHaveLength(50);
  expect(withRequests.requests["req-0"]).toBeUndefined();
  const reset = await fetch(`${base}/reset`, { method: "POST" });
  expect(reset.status).toBe(204);
  expect(await reset.text()).toBe("");
  const final = StateResponse.parse(await (await fetch(`${base}/state`)).json());
  expect(final).toEqual(initial);
  expect(publications).toHaveLength(1);
  const publication = publications[0] as { channel: string; data: unknown };
  expect(publication.channel).toBe("crew:state");
  expect(StateEnvelope.parse(publication.data).type).toBe("state.reset");
});
