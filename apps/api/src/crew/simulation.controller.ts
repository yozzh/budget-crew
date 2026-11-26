import { BadRequestException, Body, Controller, Delete, HttpCode, Inject, Post } from "@nestjs/common";
import { SimulationInput, type BudgetStateSnapshot } from "@budget-crew/shared";
import { Simulator } from "./simulator.js";

@Controller("simulation")
export class SimulationController {
  constructor(@Inject(Simulator) private readonly simulator: Simulator) {}

  @Post()
  @HttpCode(202)
  start(@Body() body: unknown): BudgetStateSnapshot["simulation"] {
    const input = SimulationInput.safeParse(body === undefined ? {} : body);
    if (!input.success) throw new BadRequestException({ error: "invalid_input" });
    return this.simulator.start(input.data.speed);
  }

  @Delete()
  @HttpCode(204)
  stop(): void {
    this.simulator.stop();
  }
}
