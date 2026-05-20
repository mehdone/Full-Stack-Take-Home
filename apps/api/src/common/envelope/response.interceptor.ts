import type { SuccessEnvelope } from "@highwood/contracts";
import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { RAW_RESPONSE_KEY } from "./raw-response.decorator.ts";

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, SuccessEnvelope<T> | T> {
  // Explicit @Inject required: the dev runtime is `tsx` (esbuild under the hood),
  // which does NOT reliably emit `design:paramtypes` decorator metadata even with
  // `emitDecoratorMetadata: true` in tsconfig. Without @Inject, NestJS DI sees
  // no type for this parameter and passes `undefined`; the first method call on
  // `this.reflector` then throws TypeError at request time. Every other
  // constructor in this app follows the same convention.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<SuccessEnvelope<T> | T> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isRaw) {
      return next.handle();
    }
    return next.handle().pipe(map((data) => ({ ok: true as const, data })));
  }
}
