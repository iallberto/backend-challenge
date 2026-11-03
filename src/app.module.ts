import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import type { Container } from "./container";
import { withLogContext } from "./infrastructure/observability/context";
import { CONTAINER, OperationsController, WageringController, WalletsController } from "./interfaces/http/controllers";

/** Lê ou gera o X-Correlation-Id e o coloca no contexto de log da requisição. */
function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("x-correlation-id");
  const correlationId = header && header.length <= 200 ? header : Bun.randomUUIDv7();
  (req as Request & { correlationId: string }).correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  withLogContext({ correlationId }, () => next());
}

@Module({})
export class AppModule implements NestModule {
  static register(container: Container): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, OperationsController],
      providers: [{ provide: CONTAINER, useValue: container }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes("*");
  }
}
