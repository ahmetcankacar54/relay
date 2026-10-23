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
      t(
        "Henüz kayıtlı hesap yok. Claude uygulamasında açık olan hesabı kaydetmek için: relay add <ad>",
        "No accounts are saved yet. To save the account open in the Claude app: relay add <name>",
      ),
    );
    return 0;
  }
  const rows = accounts.map((a) => {
    const active = a.id === state.activeProfileId;
    return [
      active ? "*" : " ",
      active ? paint(ctx.color, "bold", a.name) : a.name,
      kindText(a, t),
      a.desktop ? (a.desktop.email ?? t("kayıtlı", "saved")) : t("—", "—"),
      limitsText(limitsState(a), t),
    ];
  });
  io.stdout(table(["", t("Ad", "Name"), t("Tür", "Kind"), t("Claude uygulaması", "Claude app"), t("Limit okuma", "Usage sign-in")], rows));
  return 0;
};
