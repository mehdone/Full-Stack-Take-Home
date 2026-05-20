import type { PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * A simple pipe that validates `value` against a Zod schema.
 * The AllExceptionsFilter catches any ZodError and maps it to a
 * VALIDATION_FAILED error envelope automatically — but we throw a
 * BadRequestException here so that the HTTP status is 400 and any
 * message is preserved in standard Nest exception handling.
 *
 * For controller-level use, prefer createZodDto() from nestjs-zod, which
 * integrates with class-transformer. This pipe is available for edge cases
 * where a schema must be applied manually (e.g. pipe on a query param).
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // Throw as-is; AllExceptionsFilter handles ZodError -> VALIDATION_FAILED
      throw result.error;
    }
    return result.data;
  }
}

/**
 * Factory helper — returns a pipe instance for the given schema.
 * Usage: @Body(new zodPipe(MySchema))
 */
export function zodPipe<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
