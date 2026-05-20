import { SetMetadata } from "@nestjs/common";

export const RAW_RESPONSE_KEY = "envelope:raw_response";

/**
 * Opts a route out of the global ResponseInterceptor envelope.
 * Use for routes that return non-JSON payloads (HTML, raw OpenAPI spec, etc.).
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);
