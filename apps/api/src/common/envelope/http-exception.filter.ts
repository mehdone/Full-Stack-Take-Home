import { type ApiEnvelope, ErrorCode } from "@highwood/contracts";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const requestId = req.id;

    if (exception instanceof ZodError) {
      const body: ApiEnvelope<never> = {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: "Request validation failed",
          details: exception.issues,
          request_id: requestId,
        },
      };
      res.status(HttpStatus.BAD_REQUEST).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = httpStatusToErrorCode(status);
      // NestJS HttpException.getResponse() may be a plain string or a structured object.
      // When a structured object is thrown (e.g. ConflictException({ message, details })),
      // we extract message and details from it so callers can include rich context.
      const exceptionResponse = exception.getResponse();
      let message = exception.message;
      let details: unknown;
      if (typeof exceptionResponse === "object" && exceptionResponse !== null) {
        const r = exceptionResponse as Record<string, unknown>;
        if (typeof r.message === "string") {
          message = r.message;
        }
        if ("details" in r) {
          details = r.details;
        }
      }
      const body: ApiEnvelope<never> = {
        ok: false,
        error: {
          code,
          message,
          ...(details !== undefined ? { details } : {}),
          request_id: requestId,
        },
      };
      res.status(status).json(body);
      return;
    }

    // Postgres error codes — fallback if the service didn't catch and re-throw
    if (isPostgresError(exception)) {
      if (exception.code === "23505") {
        // unique_violation: map to CONFLICT; services should throw ConflictException with
        // details before reaching here so callers get a richer message.
        const body: ApiEnvelope<never> = {
          ok: false,
          error: {
            code: ErrorCode.CONFLICT,
            message: "A resource with that identifier already exists",
            request_id: requestId,
          },
        };
        res.status(HttpStatus.CONFLICT).json(body);
        return;
      }
    }

    // Unhandled — internal error
    this.logger.error({
      event: "unhandled_exception",
      error: exception instanceof Error ? exception.message : String(exception),
      stack: exception instanceof Error ? exception.stack : undefined,
      requestId,
    });

    const body: ApiEnvelope<never> = {
      ok: false,
      error: {
        code: ErrorCode.INTERNAL,
        message: "An unexpected error occurred",
        request_id: requestId,
      },
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}

function httpStatusToErrorCode(status: number): (typeof ErrorCode)[keyof typeof ErrorCode] {
  switch (status) {
    case HttpStatus.NOT_FOUND:
      return ErrorCode.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ErrorCode.CONFLICT;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ErrorCode.RATE_LIMITED;
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return ErrorCode.VALIDATION_FAILED;
    default:
      if (status >= 500) return ErrorCode.INTERNAL;
      return ErrorCode.VALIDATION_FAILED;
  }
}

interface PostgresError {
  code: string;
  message: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}
