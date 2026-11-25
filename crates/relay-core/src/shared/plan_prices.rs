//! Port of `shared/plan-prices.ts`: Claude subscription list prices per month in USD.

use super::types::AccountPlan;

pub const PLAN_PRICES_CHECKED: &str = "2026-10-23";
pub const PLAN_PRICES_SOURCE: &str = "https://claude.com/pricing";

/// `PLAN_PRICES[plan]`: Pro, Max 5x and Max 20x; Team and unknown plans have none.
pub fn plan_price(plan: AccountPlan) -> Option<f64> {
    match plan {
        AccountPlan::Pro => Some(20.0),
        AccountPlan::Max5 => Some(100.0),
        AccountPlan::Max20 => Some(200.0),
        AccountPlan::Unknown | AccountPlan::Team => None,
    }
}
