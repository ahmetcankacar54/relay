# Relay interface system

Relay is a small macOS utility. It looks like the macOS system apps and Linear: greys only, a dark
window with the sidebar on it, pages on a slightly lighter inset panel, grouped boxes and system-size
controls. Colour is kept for small status marks: a green dot for running or ready, an amber mark for
a step to take, red for a used-up limit or an error. Tokens live in `src/styles/theme.css`; the
shadcn primitives in `src/components/ui` read only tokens.

## Tokens

| Role                   | Light     | Dark      |
| ---------------------- | --------- | --------- |
| Window and sidebar     | `#f4f4f5` | `#0f0f11` |
| Page panel             | `#fcfcfd` | `#151517` |
| Grouped box            | `#ffffff` | `#1a1a1d` |
| Text                   | `#18181b` | `#ededef` |
| Secondary text         | `#66666d` | `#8e8e96` |
| Separator              | `#e7e7ea` | `#27272b` |
| Control face           | `#ffffff` | `#242428` |
| Primary button         | `#18181b` | `#e6e6e9` |
| Meter (rings and bars) | `#3f3f46` | `#d4d4d8` |

The window is solid: no vibrancy, so the wallpaper never tints it. Rings and bars are grey at every
level; the warnings say the level in words, and only a used-up limit turns red. Timeline rows use four
greys (`--tone-1`…`--tone-4`).

Secondary text keeps 4.5:1 contrast or better on the panel, boxes, popovers, muted grounds and the
sidebar in both schemes (`tests/shell.test.ts` checks it).

## Type

The system font (SF Pro). Sizes follow the macOS ramp:

| Token       | Size  | Use                                  |
| ----------- | ----- | ------------------------------------ |
| `text-2xs`  | 11 px | Axis ticks, keys, small badges       |
| `text-xs`   | 12 px | Secondary lines, descriptions        |
| `text-sm`   | 13 px | Body, controls, rows                 |
| `text-lg`   | 15 px | Page title in the toolbar            |
| `text-xl`   | 17 px | The active account name              |
| `text-2xl`  | 22 px | Large figures (ring percent)         |

Section labels above grouped boxes are `text-xs font-semibold text-muted-foreground`, not uppercase.

## Layout and controls

- Sidebar: 200 px (an 80 px icon rail under 840 px) on the window grey, 28 px rows, grey icons, a
  translucent grey fill for the selected row. The top 52 px strip holds the traffic lights and drags
  the window.
- Page panel: inset 8 px from the window edge, 10 px corners, a hairline border.
- Toolbar: each page header is a sticky 52 px row with the title, an optional subtitle and the page
  actions. It drags the window and shows its bottom edge only when content scrolls under it.
- Limits read as rows of bars (`LimitBars`), as in the macOS Battery and Storage panes: the name, a
  bar, the percent and when it renews. Lists keep small concentric rings.
- Controls: 28 px default (`h-7`), 24 px small, 32 px large; 6 px corners; 14 px icons. Inputs and
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
- Respect reduced motion. Check Turkish and English, the 80 px rail, the 720×560 minimum window and
  a wide window. No horizontal page overflow.

## Daily chart

An hourly ruler with compact comparison rows, and a circular day view with midnight at the top.
Proposed windows are dashed, verified server resets are solid and the current time is a white line.
Account names, dated ranges and exclusions stay textual; colour alone never carries eligibility or
reset provenance. SVG paths for the dial and CSS for the timeline; no chart dependency.

## Copy

Short, direct sentences; one instruction per sentence; the names in `docs/ux/glossary.md`. A line of
help stays only when the label does not already say it.
