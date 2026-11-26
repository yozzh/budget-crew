import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ConfigService } from "./config/config.service.js";

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix("api");
app.enableShutdownHooks();
const { PORT, HOST } = app.get(ConfigService).env;
await app.listen(PORT, HOST);
