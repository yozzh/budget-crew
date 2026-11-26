import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import { TextCommand } from "@budget-crew/shared";
import { ExpenseFlow } from "./expense-flow.js";
import { clientIp, type ClientRequest } from "./client-ip.js";

@Controller("expenses")
export class ExpenseController {
  constructor(@Inject(ExpenseFlow) private readonly flow: ExpenseFlow) {}

  @Post()
  @HttpCode(202)
  submit(@Body() body: unknown, @Req() request: ClientRequest): { requestId: string } {
    const input = TextCommand.safeParse(body);
    if (!input.success) throw new BadRequestException({ error: "invalid_input" });
    return this.flow.submit(input.data.text, clientIp(request));
  }
}
