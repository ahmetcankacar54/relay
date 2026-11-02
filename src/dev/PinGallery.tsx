import { LOST_ITEM_KINDS, LOST_TIERS } from "../../shared/lost-found";
import { LostPin } from "../pages/usage/LostPins";
import { SHEET_CARDS } from "../pages/usage/lost-pin-palette";

/** Development only: the lost and found's pins on light and dark cards, in every finish and locked. */
export function PinGallery() {
  const rows = [
    ...LOST_TIERS.map(({ tier }) => ({ label: tier, tier, locked: false })),
    { label: "locked", tier: "bronze" as const, locked: true },
  ];
  return (
    <main className="grid gap-6 p-6">
      {SHEET_CARDS.map(({ bg, fg }) => (
        <section
          key={bg}
          className="grid gap-4 rounded-2xl p-5"
          style={{ background: bg, color: fg }}
        >
          {rows.map((row) => (
            <div key={row.label} className="flex flex-wrap items-end gap-3">
              <span className="w-14 text-xs">{row.label}</span>
              {LOST_ITEM_KINDS.map((kind) => (
                <LostPin
                  key={kind}
                  kind={kind}
                  tier={row.tier}
                  locked={row.locked}
                  size={88}
                />
              ))}
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-3">
            <span className="w-14 text-xs">40 / 24</span>
            {LOST_ITEM_KINDS.map((kind) => (
              <LostPin key={kind} kind={kind} tier="gold" size={40} />
            ))}
            {LOST_ITEM_KINDS.map((kind) => (
              <LostPin key={kind} kind={kind} tier="silver" size={24} />
            ))}
            <LostPin kind="clocks" sealed locked size={40} />
          </div>
        </section>
      ))}
    </main>
  );
}
