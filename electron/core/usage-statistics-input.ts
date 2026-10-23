import { z } from "zod";

/** Input of relay:usage-statistics; Node-safe so tests can import it. */
export const usageStatisticsInput = z
  .object({
    range: z.union([z.literal(7), z.literal(30), z.literal(90)]),
    accountId: z.uuid().optional(),
  })
  .strict();
