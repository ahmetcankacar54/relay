# Relay interface system

Relay is a small macOS utility. It looks and behaves like a native Mac app: a quiet window, a
source-list sidebar, a toolbar with the page title, grouped boxes and system-size controls. One orange
accent marks the primary action and the selection. Tokens live in `src/styles/theme.css`; the shadcn
primitives in `src/components/ui` read only tokens.

## Tokens

| Role              | Light                | Dark                     |
| ----------------- | -------------------- | ------------------------ |
| Window            | `#f6f6f7`            | `#1e1e1f`                |
| Grouped box       | `#ffffff`            | `#28282a`                |
| Sidebar           | `#f2f2f4` (material) | `#252527` (material)     |
| Text              | `#1d1d1f`            | `#f5f5f7`                |
| Secondary text    | `#6e6e73`            | `#a1a1a6`                |
| Separator         | `#e3e3e5`            | `#38383b`                |
| Control face      | `#ffffff`            | `#48484c`                |
| Accent (primary)  | `#c2410c`            | `#ff8a4c`                |

In the Electron main window on macOS the sidebar is transparent over the system sidebar material
(`vibrancy: "sidebar"` in `electron/main.ts`, the `vibrant:` variant in CSS). The browser preview
and other platforms use the opaque `--sidebar` grey.

Secondary text keeps 4.5:1 contrast or better on the window, boxes, muted grounds and the sidebar in
both schemes (`tests/shell.test.ts` checks it).

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

- Sidebar: 200 px (a 56 px icon rail under 840 px), 28 px rows, accent-tinted icons, a translucent
  grey fill for the selected row. The top 52 px strip holds the traffic lights and drags the window.
- Toolbar: each page header is a sticky 52 px row with the title, an optional subtitle and the page
  actions. It drags the window and shows its bottom edge only when content scrolls under it.
- Controls: 28 px default (`h-7`), 24 px small, 32 px large; 6 px corners; 14 px icons. Inputs and
  select triggers have the same heights as buttons at each size.
- Tabs and toggle groups are segmented controls: a light track with a raised selected segment.
- Grouped boxes: 10 px corners, a hairline border, no shadow; rows divided by hairlines.
- Menus and selects highlight the focused item with the accent fill.
- Focus is a visible 3 px accent ring. Hover changes colours, never sizes.
- Time uses a custom nonmodal popover: hour/minute grid, every-minute text entry, staged Apply/Cancel.
  Existing `09:17` must not round to a grid increment. Parent state changes only after valid Apply.
- Time zone uses a searchable nonmodal popover: explicit IANA identity, city and dated UTC offset.
  Preserve valid aliases; do not save arbitrary partial queries or UTC offsets as zones.
- Both popovers portal to the document body, fit the viewport, dismiss on Escape/outside interaction
  and handle keyboard traversal without trapping focus or stealing outside-click focus.
- Schedule changes remain drafts until Save plan. Account plan/capacity changes keep their
  immediate-save contract, with visible copy.
- Respect reduced motion. Check Turkish and English, the 56 px rail, the 720×560 minimum window and
  a wide window. No horizontal page overflow.

## Daily chart

An hourly ruler with compact comparison rows, and a circular day view with midnight at the top.
Proposed windows are dashed, verified server resets are solid and the current time is orange.
Account names, dated ranges and exclusions stay textual; colour alone never carries eligibility or
reset provenance. SVG paths for the dial and CSS for the timeline; no chart dependency.

## Copy

Short, direct sentences; one instruction per sentence; the names in `docs/ux/glossary.md`. A line of
help stays only when the label does not already say it.
