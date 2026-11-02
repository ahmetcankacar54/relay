import type { AccountPlan } from "./types";

/**
 * Claude subscription list prices per month in USD, billed monthly, to tell when a week's API value has paid for
 * an account's plan. Hand-maintained like shared/model-prices.ts. Team is left out: Relay does not know whether a
 * seat is standard or premium, and the two differ fivefold.
 */
export const PLAN_PRICES_CHECKED = "2026-10-23";
export const PLAN_PRICES_SOURCE = "https://claude.com/pricing";

export const PLAN_PRICES: Partial<Record<AccountPlan, number>> = {
  pro: 20,
  max5: 100,
  max20: 200,
};
