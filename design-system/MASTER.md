# Relay interface system

Source: the user-invoked [UI/UX Pro Max skill](~/.agents/skills/ui-ux-pro-max/SKILL.md), its design-system/productivity-color searches and React/keyboard-form guidance. This is an existing desktop utility, so landing-page CTA layouts and oversized display typography from broad search results do not apply.

## Direction

Use a quiet modern workspace: neutral canvas, white surfaces, graphite text and restrained teal actions. Keep the existing bundled DM Sans and Manrope fonts; avoid new network fonts and chart dependencies. Separate the daily chart, hours/days and account configuration by their purpose. Advanced controls stay in disclosures. Do not change account switching, quota inference or routine consent while changing presentation.

## Tokens

| Role           | Value                 |
| -------------- | --------------------- |
| Canvas         | `#f3f6f8`             |
| Surface        | `#ffffff`             |
| Main text      | `#19232f`             |
| Secondary text | `#526173` / `#405267` |
| Borders        | `#dce4eb`             |
| Teal action    | `#0f766e`             |
| Teal surface   | `#e7f4f1`             |
| Warning text   | `#7a4c17`             |

Normal text needs 4.5:1 contrast or better. Use 14–16px body copy, 12–13px chart legends/axes and 20–22px section titles. Chart color alone never carries eligibility or reset provenance. Retain the dashed proposed window, solid server diamond and current-time marker with text equivalents.

## Controls

- Primary picker, day and navigation targets are at least 44px. Hover changes colors, not dimensions. Focus uses a visible teal ring.
- Time uses a custom nonmodal popover: hour/minute grid, every-minute text entry, staged Apply/Cancel. Existing `09:17` must not round to a grid increment. Parent state changes only after valid Apply.
- Time zone uses a searchable nonmodal popover: explicit IANA identity, city and dated UTC offset. Preserve valid aliases; do not save arbitrary partial queries or UTC offsets as zones.
- Both popovers portal to the document body, fit the viewport, dismiss on Escape/outside interaction and handle keyboard traversal without trapping focus or stealing outside-click focus.
- Schedule changes remain drafts until Save plan. Account plan/capacity changes retain their immediate-save contract, with visible copy. Saved routine status stays distinct from staged checkbox state.
- Respect reduced motion. Verify Turkish/English, a narrow in-app panel, 720×560 minimum desktop and wider desktop layouts. No horizontal page overflow.

## Daily instrument — 0.8

The user requested a clearer 24-hour display. Applying the [Frontend Design skill](~/.agents/skills/frontend-design/SKILL.md), the chart now uses a precise, quiet instrument layout: an hourly ruler and compact comparison rows, with a second circular day view. Midnight begins at the top of the dial. Four six-hour timeline sections provide orientation without implying extra working periods. Keep proposed windows dashed, verified server resets solid and current time orange. Account names, dated ranges and exclusions remain textual.

Use SVG paths for the dial and CSS for the timeline; no chart dependency is necessary for this bounded display. Project the existing civil-day segments, preserving DST gaps/overlaps and clipped endpoints. A full 00–24 circle requires two arcs. At most four account rings are plotted; disclose the limit and retain all account descriptions. Empty selection still shows working hours and tells the user how to add account windows. The chart views and date controls are visual-only state.

Implementation: `src/modern.css`, `src/schedule.css`, `src/DailySchedule.tsx`, `src/TimePicker.tsx`, `src/TimeZonePicker.tsx` and the planning model. Actual account/routine operations remain outside the visual layer.
