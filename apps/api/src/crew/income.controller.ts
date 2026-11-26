import { BadRequestException, Body, Controller, HttpCode, Inject, Post } from "@nestjs/common";
import { TextCommand } from "@budget-crew/shared";
import { ExpenseFlow } from "./expense-flow.js";

@Controller("incomes")
export class IncomeController {
  constructor(@Inject(ExpenseFlow) private readonly flow: ExpenseFlow) {}

  @Post()
  @HttpCode(202)
  submit(@Body() body: unknown): { requestId: string } {
    const input = TextCommand.safeParse(body);
    if (!input.success) throw new BadRequestException({ error: "invalid_input" });
    return this.flow.submitIncome(input.data.text);
  }
}
