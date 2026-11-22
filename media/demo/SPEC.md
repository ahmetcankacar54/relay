# SPEC · Relay · "The 4:47 PM limit"

GOAL:    A Mac user with two Claude plans watches one afternoon's limit get solved by one click, sees that
         Relay also plans the day and routes requests, and leaves knowing where to download it.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, H.264 yuv420p for the site (site/assets/relay-demo.mp4).
TIME:    28.6 s x 30 = 858 frames. No music (no source this run); the cuts follow the cursor and the UI.

LOOK:    ground #f5f4f2 flat, no texture, no vignette, no grain.
         ink #1c1917 for every title; quiet lines #645e58; hairlines #e8e5e1.
         accent Relay orange: #c2410c (button and text) / #ea580c (marks). Allowed only on the Switch click
         (the real button), the gateway toggle (the real control) and the end card's CTA button. The UI keeps
         its own status colours (red Full, green In use, account tones).
         display: Inter 700, titles 72 px / line-height 1.0 / tracking -2 %; the hook "4:47 PM" 128 px.
         quiet lines: Inter 400, 32-34 px, tracking -0.5 %. Nothing below 26 px meant to be read.
         medium: the real Relay UI, captured from the browser preview at 3x (window) and 4x (panel, switch
         window), shown 1.0x (home stage) to 2.0x (punch-ins). The window is a macOS window: 12 px corners
         (CSS), hairline rgba(28,25,23,.12), traffic lights, shadow 0 30 80 rgba(28,25,23,.16) +
         0 4 14 rgba(28,25,23,.08). The panel is a popover: 12 px corners, same hairline and shadow.
         depth: shadows only on the two windows and the end-card icon (contact shadow 0 18 40 /.18).

OBJECTS: - the menu-bar panel (panel.html, scenario film / film-before): Personal · Max 97 % then
           "Full · 1 h 50 min", Personal · Backup "suggested" with its orange Switch.
         - the switch window (switch.html, SwitchStage): the red panda walks through the orange door,
           "Relay switches to Personal · Backup", comes back in a fedora and moustache, tosses them, bows:
           "You are on Personal · Backup". Rendered frame by frame from the real CSS animations.
         - the main window: Overview (Personal · Backup In use, all 7 accounts), Planning (Today chart),
           Proxy & Gateway (off, then running with Recent requests).
         - the macOS pointer: black arrow, 2 px white edge, 58 px tall (5.4 % of the frame).
         - the app icon (assets/icons/app-1024.png), 200 px, never redrawn.

MOTION:  enter expo.out 0.5-0.7 s; camera power2.inOut 0.6 s; exits power3.in, 40-50 % of the entrance;
         titles per word blur 8 px -> 0 + opacity, 0.16 s, 0.07 s apart, no translate; landed titles are
         dead still; title exits blur-out 0.2 s. Cursor travel power3.out 0.6-0.7 s on a slight arc; press
         = cursor scale 0.86 and button scale 0.95 for 4 frames. Icon lands on a spring (damping ~0.7,
         elastic.out(1, 0.75)) from 160 px above. Request rows reveal 0.08 s apart.

SHOTS:   (frames at 30 fps)
  1 · 0-111 (0.0-3.7 s) Hook. Panel 2.0x hanging from the top edge, right half; "4:46 PM" 128 px left.
      f15 the minute rolls to 4:47 (slot roll 4 f); f17-24 the 5-hour row crossfades 97 % -> Full.
      f27 "Personal · Max is full" blurs in. f57 cursor enters bottom-right, lands on Switch f78, hover
      colour f78, click f90. Hands off: the panel's shell closes into the switch window's card f92-101.
  2 · 99-252 (3.3-8.4 s) Switch. Card appears at the panel's top (real position: the switch window
      opens where the panel was) at 2x, camera pushes to 4x centred f101-122. Real story plays 4.2 s:
      "Relay switches to Personal · Backup" (f99-150), "You are on Personal · Backup" (f150-225).
      Hands off: the card shrinks into the Overview's account card f230-243 (carry across).
  3 · 236-399 (7.85-13.3 s) Overview. Window settles at 1.7x on the account in use f236-254, hold to
      f291. Pull back to the home stage (0.96x, window right) f291-309. "Every limit, every account" +
      "Claude, Codex and Antigravity" left f312-330, hold to f392. Cursor to sidebar Planning f357-384,
      click f399. Hands off: click = page swap in the same frame.
  4 · 399-561 (13.3-18.7 s) Planning. "A plan for your day" + "5-hour windows across your work hours"
      f403-415. Windows draw across the day f410-455, row by row 0.15 s apart, the forecast last.
      Push to the chart 1.65x f477-495 ("No gaps · 2 switches" 26 px), hold to f525, pull back f525-543.
      Cursor to sidebar Proxy & Gateway f537-555, click f561. Hands off: page swap.
  5 · 561-702 (18.7-23.4 s) Gateway. Push to 1.7x on the page's own line ("One address; each request
      goes to the account with room") and the switch f564-582; click f594, Gateway running. Glide to
      the pool beside Recent requests 1.8x f606-624; rows arrive f616-636; hold to f680. Hands off: the
      window drops back and blurs out f680-693 as the icon falls in.
  6 · 684-858 (22.8-28.6 s) End card. Icon lands f693-718; "Relay" wipes in beside it f714-728;
      "Every Claude account, one menu-bar app." f726; CTA "Download for macOS" and
      "github.com/ahmetcankacar54/relay" f747; hold to the end (3.7 s).
  Punch-ins keep the frame's left edge at window x 224, past the sidebar's labels, so no word is cut;
  the window's right edge and its shadow show at the right.

BANNED:  dark void; glow, bloom, particles, lens flares; purple/blue gradients, glass; cream-paper + serif
         + italic accents + mono caps labels + pill chips; everything centred; everything fading and
         sliding up; text moving while read; corner labels, frame borders, HUD; three cards in a row;
         title over a dimmed screenshot; logo docked in a corner; click rings; breathing/floating loops;
         slow creeping push on a landed frame; an invented Claude app screen or any UI not captured from
         the preview; numbers not on screen in the preview; tilted 3D UI; words cut by the frame edge in
         a punch-in (found in the first pass: sidebar fragments, fixed).

QA:      f0 thumbnail (panel + 4:46 PM, never empty) · f24 "Full" on screen · f90 click on Switch ·
         f132 panda at the door, line readable · f190 disguise + "You are on Personal · Backup" ·
         f270 "In use" readable at 1.7x · f327 home stage with title, nothing clipped · f440 windows
         drawing · f507 "No gaps · 2 switches" >= 26 px · f600 "Gateway running" · f645 request rows ·
         f810 end card lockup 15-30 % of the width, CTA held.
