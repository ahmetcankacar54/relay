# Relay interface system

Relay is a small macOS utility. It looks like the macOS system apps and Linear: greys only, a
translucent sidebar on the system material, pages in the same dark colour beside it (a hairline border
tells them apart), grouped boxes and 16 px text. Colour is kept for small status marks: a green dot for running or ready, an amber mark for
a step to take, red for a used-up limit or an error. Tokens live in `src/styles/theme.css`; the
shadcn primitives in `src/components/ui` read only tokens.

## Tokens

| Role                   | Light     | Dark      |
| ---------------------- | --------- | --------- |
| Window, sidebar, page  | `#f4f4f5` | `#0f0f11` |
| Grouped box            | `#ffffff` | `#1a1a1d` |
| Text                   | `#18181b` | `#ededef` |
| Secondary text         | `#66666d` | `#8e8e96` |
| Separator              | `#e7e7ea` | `#27272b` |
| Control face           | `#ffffff` | `#242428` |
| Primary button         | `#18181b` | `#e6e6e9` |
| Meter (rings and bars) | `#3f3f46` | `#d4d4d8` |

In the Electron main window on macOS the sidebar is transparent over the system sidebar material
(`vibrancy: "sidebar"` in `electron/main.ts`, the `vibrant:` CSS variant); the page stays solid. The
browser preview and other platforms use the solid grey. Rings and bars are grey at every
level; the warnings say the level in words, and only a used-up limit turns red. Timeline rows use four
greys (`--tone-1`…`--tone-4`).

Secondary text keeps 4.5:1 contrast or better on the panel, boxes, popovers, muted grounds and the
sidebar in both schemes (`tests/shell.test.ts` checks it).

## Type

The system font (SF Pro), 16 px body text:

| Token       | Main window | Panel and switch window | Use                            |
| ----------- | ----------- | ----------------------- | ------------------------------ |
| `text-2xs`  | 12 px       | 11 px                   | Axis ticks, keys, small badges |
| `text-xs`   | 14 px       | 12 px                   | Secondary lines, descriptions  |
| `text-sm`   | 16 px       | 13 px                   | Body, controls, rows           |
| `text-lg`   | 18 px       | 15 px                   | Page title in the toolbar      |
| `text-xl`   | 20 px       | 17 px                   | Large names                    |
| `text-2xl`  | 24 px       | 22 px                   | Large figures                  |

The menu bar panel (360 px) and the switch window set `data-density="compact"` on the root, which swaps
the ramp. Icons are Relay's own (`src/components/icons.tsx`, a 1.5 px line); lucide icons elsewhere
draw with the same 1.5 px line.

Section labels above grouped boxes are `text-xs font-semibold text-muted-foreground`, not uppercase.

## Layout and controls

- Sidebar: 232 px by default, 200–360 px by dragging its edge (←/→ on the focused edge, double-click
  for the default). Dragging below 150 px folds it into the 84 px icon rail, as does ⌃⌘S, the toggle
  beside the traffic lights, or a window under 900 px. Rows are 32 px with 20 px icons; rail items
  are 40 px squares. The top 52 px strip holds the traffic lights (16 px in, so they fit the rail)
  and drags the window. The size is kept in `localStorage`.
- Pages in the sidebar: Overview, Accounts, then a "Usage" group with Limits, Tokens and cost, and
  Pins (each its own page, no tabs), then Settings at the bottom. ⌘1–⌘5 open them in order.
- Page: the window colour, with a hairline border on the sidebar side.
- Rows with actions (the account page's connections) share columns: a refresh icon button, then the
  text button at the right edge, so both line up across rows. Leading marks have no ground.
- Icon-only buttons in the toolbar are ghost buttons (no ground until hover).
- The "When do I work?" heatmap has square cells that scale with the width (the grid stops at 768 px).
- Toolbar: each page header is a sticky 52 px row with the title, an optional subtitle and the page
  actions. It drags the window and shows its bottom edge only when content scrolls under it.
- Limits read as rows of bars (`LimitBars`), as in the macOS Battery and Storage panes: the name, a
  bar, the percent and when it renews. Lists keep small concentric rings.
- Controls: 32 px default (`h-8`), 28 px small, 40 px large; 6 px corners; 16 px icons. Inputs and
  select triggers have the same heights as buttons at each size.
- Tabs and toggle groups are segmented controls: a light track with a raised selected segment.
- Grouped boxes: 10 px corners, a hairline border, no shadow; rows divided by hairlines.
- Menus and selects highlight the focused item with a grey fill.
- Focus is a visible 3 px grey ring. Hover changes colours, never sizes.
- Time uses a custom nonmodal popover: hour/minute grid, every-minute text entry, staged Apply/Cancel.
  Existing `09:17` must not round to a grid increment. Parent state changes only after valid Apply.
- Time zone uses a searchable nonmodal popover: explicit IANA identity, city and dated UTC offset.
  Preserve valid aliases; do not save arbitrary partial queries or UTC offsets as zones.
- Both popovers portal to the document body, fit the viewport, dismiss on Escape/outside interaction
  and handle keyboard traversal without trapping focus or stealing outside-click focus.
- Schedule changes remain drafts until Save plan. Account plan/capacity changes keep their
  immediate-save contract, with visible copy.
- Respect reduced motion. Check Turkish and English, the 84 px rail, the 720×560 minimum window and
  a wide window. No horizontal page overflow.

## Daily chart

An hourly ruler with compact comparison rows, and a circular day view with midnight at the top.
Proposed windows are dashed, verified server resets are solid and the current time is a white line.
Account names, dated ranges and exclusions stay textual; colour alone never carries eligibility or
reset provenance. SVG paths for the dial and CSS for the timeline; no chart dependency.

## Copy

Short, direct sentences; one instruction per sentence; the names in `docs/ux/glossary.md`. A line of
help stays only when the label does not already say it.
