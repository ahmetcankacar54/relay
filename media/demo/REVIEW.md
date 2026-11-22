# REVIEW · Relay · "The 4:47 PM limit"

## Creative calls
- Built storyline A (picked). B "All at once" and C "A day in 5-hour windows" are in STORYLINES.md.
- Everything that claims to be Relay is Relay: every state was captured from the browser preview
  (capture/shoot.mjs, capture/jobs.json) with the clock fixed at Mon 23 Nov 2026 16:47. New dev-only
  scenarios in src/preview.ts: `film-before` (97 %), `film` (Personal · Max Full, Personal · Backup
  suggested), `film-switched` (Backup in use), `film-planning` (planning at the planned pace).
- The switch moment is the app's real switch window (switch.html → SwitchStage), rendered frame by
  frame from its own CSS animations (capture/switch.mjs, assets/switch-stage.mp4), opened where the
  panel was, as the app does. No Claude app screen is shown.
- Planning windows "draw in" by revealing the real chart (planning.png) over the same page with its
  bars hidden (planning-bare.png). Gateway rows arrive top-down over the real running page; the
  preview shows them all at once, so this is the only staged reveal in the film.
- Titles: "4:46/4:47 PM", "Personal · Max is full", "Every limit, every account" / "Claude, Codex and
  Antigravity", "A plan for your day" / "5-hour windows across your work hours", end card copy as
  given. The gateway beat uses the page's own line instead of a title.

## Measured / looked at
- `check --json`: ok, 0 errors; one warning kept (film_silent, below). Craft pass: no line_unread,
  dead_stretch or text_below_floor.
- `snapshot --review` (beats, 10 seam strips, phone sheet) looked at twice; extra stills at every
  click, seam and punch-in; frames pulled from the rendered MP4 and checked.
- Fixed after the first pass: sidebar words cut by the frame edge in punch-ins (left edge now at
  window x 224), the empty shell between panel and switch card, an empty cream frame before the icon,
  a ghosting crossfade on the gateway click (now an instant swap, as the app does), the cursor
  covering the "Switch" label.
- Nobody heard anything: the film is silent.

## Weakest shot
- 7.65–8.1 s, the switch card carried into the Overview: the card fades over the window for ~5 frames
  and reads a little muddy. With more time: cut the card on the window's settle frame instead.
- On a phone the home-stage UI (window at 0.96x) is decoration only; the titles and punch-ins carry it.

## Warnings kept
- film_silent: no music source this run (no HeyGen sign-in, no local model asked for). Add a bed with
  `npx hyperframes media-use resolve --type bgm …` after `npx hyperframes auth login`, plus clicks on
  the four cursor presses (3.0, 13.3, 18.7, 19.8 s).
- canvas_covered / panel_out_of_canvas / container_overflow (info): the ground, the panel hanging off
  the bottom edge and the minute roll's hidden digit, all intended.
