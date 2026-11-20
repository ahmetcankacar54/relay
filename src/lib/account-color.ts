/*
 * An account's own colour, one map for every place it shows: its dot, its lane in the plan, its
 * bar in a breakdown and its series in a chart. The tokens are `--account-*` in theme.css.
 */
const FILL = {
  terra: "bg-account-terra",
  olive: "bg-account-olive",
  blue: "bg-account-blue",
  plum: "bg-account-plum",
} as const;

type AccountColor = keyof typeof FILL;
const known = (color: string | undefined): color is AccountColor => !!color && color in FILL;

/** The colour as a fill class; an account without one is grey. */
export const accountFill = (color: string | undefined) => (known(color) ? FILL[color] : "bg-account-none");

/** The colour as a CSS value, for a chart series. */
export const accountColor = (color: string | undefined) => `var(--account-${known(color) ? color : "none"})`;
