import { BaseEnvFragment } from "@highwood/config";
import { z } from "zod";

export const AlertingEnvSchema = BaseEnvFragment.extend({
  ALERTING_PORT: z.coerce.number().int().positive().default(4100),
});

export type AlertingEnv = z.infer<typeof AlertingEnvSchema>;
