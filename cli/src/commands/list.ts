import type { Command } from "../command";
import { openContext } from "../context";
import { kindText, limitsState, limitsText } from "../describe";
import { paint, printJson, table } from "../output";

export const list: Command = async ({ io, deps, parsed, t }) => {
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const state = await ctx.desktop.snapshot();
  const accounts = ctx.store.state.accounts;
  if (ctx.json) {
    printJson(
      io,
      accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        group: a.group,
        active: a.id === state.activeProfileId,
        desktop: { linked: !!a.desktop, ...(a.desktop?.email ? { email: a.desktop.email } : {}) },
        limits: limitsState(a),
      })),
    );
    return 0;
  }
  if (!accounts.length) {
    io.stdout(
      t("list.noAccountsAreSavedYetTo"),
    );
    return 0;
  }
  const rows = accounts.map((a) => {
    const active = a.id === state.activeProfileId;
    const providerName = (a.provider ?? "claude").toUpperCase();
    return [
      active ? "*" : " ",
      active ? paint(ctx.color, "bold", a.name) : a.name,
      providerName,
      kindText(a, t),
      a.desktop ? (a.desktop.email ?? t("list.saved")) : t("list.msg"),
      limitsText(limitsState(a), t),
    ];
  });
  io.stdout(
    table(
      ["", t("list.name"), t("common.provider"), t("list.kind"), t("common.claudeApp"), t("list.usageSignIn")],
      rows,
    ),
  );
  return 0;
};

