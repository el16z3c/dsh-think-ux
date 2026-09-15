# local-dsh-think-ux

DOM-layer client plugin that replaces the two first-generation bundle patches
(think-expand + autoscroll gesture guard) with a proper DSH client plugin.
It is NOT upgrade-proof: it relies on stable DOM attributes, a click-to-toggle
row, and the bundle's plain `scrollTop` write path (see Residual risks). Its
guarantee is a graceful, documented degradation — not immunity.

## Behavior

1. **Think rows expand while reasoning streams.** Any `[data-variant="think"]`
   row with `data-state="running"` is auto-expanded via a synthetic click on
   its `[data-disclosure-row]` element (React keeps owning the state). When the
   row settles (`data-state="ok"`) the plugin auto-collapses it — unless the
   reader toggled that row themselves; a trusted click on the row hands it over
   permanently (plugin never touches it again for the row's lifetime).
   History rows and rows under `[data-turn-process-inline][hidden]` are left
   alone.
   While auto-expanded, the body is a **capped preview**: at most 24 lines
   (line height taken from the bundle's own secondary-content token,
   `calc(20px + var(--dsh-content-font-delta-secondary,0px))`), with 24 px
   top/bottom fades. It is a hidden-scrollbar scroll box that a single rAF
   ticker **chases to the bottom** with the main view's smooth-episode
   step (70 ms time constant `CHASE_TAU_MS`, constant `CHASE_MAX_PX`
   speed ~960 px/s — the preview body is at most ~500 px, below the
   `GAP_FAST_MIN` threshold, so it always glides), so appended streaming
   text glides up smoothly instead of jumping in token chunks. A reader scroll up inside the preview
   **pauses** that row's follow (terminal style); returning within 25 px of
   the bottom resumes it. The cap applies only to plugin-managed rows: a
   reader toggle lifts it permanently for that row (their expansion is
   full-height and unscrollable), and settle auto-collapse removes it
   anyway.

2. **Reader scroll intent via a `scrollTop` write trap.** Any reader-initiated
   upward movement (wheel up, touch finger-down drag, PageUp/Home/ArrowUp, or
   any upward `scrollTop` drift) arms a 700 ms intent window. A passive clamp
   is NOT reader intent: when content above the reader shrinks (a settled
   think row collapsing), the browser clamps `scrollTop` down — it reads as
   upward drift but ends at the floor, so it does not arm (otherwise every
   turn boundary would freeze the smooth follow for 700 ms and fast-catch-up).
   A real upward move leaves the at-bottom band within a few frames and arms
   there. The plugin then installs a `defineProperty` trap on the scroller's
   `scrollTop`.

   The discriminator is structural, not heuristic: the bundle's follow re-pin
   is a plain JS assignment (`el.scrollTop = el.scrollHeight` in
   `toBottom`/`followRef`), while every reader input method — wheel, touch,
   scrollbar thumb, track click — scrolls natively inside the browser and never
   passes through the JS property setter. So **the reader's return can never be
   misclassified** (no event-shape heuristics, no thresholds to tune):

   - a write whose target is at or beyond floor-minus-25 while the reader sits
     more than 25 px above the floor (inside the window) is a re-pin (the
     bundle writes `el.scrollHeight`, which overshoots and is clamped to the
     floor): it is let land (the bundle's own bookkeeping stays consistent)
     and the reader's position is restored in the same tick — the yank never
     paints, and the resulting scroll event makes the bundle's 500 ms sample
     heal `atBottomRef=false`, so it stops re-pinning on its own;
   - a DOWNWARD arrival within 45 px of the floor (the re-follow zone) ends the
     intent and actively bottoms out: the pristine bundle only re-engages its
     follow at its own 25 px threshold, so a reader stopping in the 25–45 px
     band would otherwise strand (intent off, follow dead). The ≤45 px
     bottom-out nudge lands the bundle at 0 px, where its debounced sample
     flips `atBottomRef` back to true and native follow resumes (typically
     within the 500 ms sample debounce plus the next content chunk). A reader
     who PASSES through the band on the way up is armed, not nudged; a reader
     who stops there is left there.
   - exceptions (re-pin-shaped writes LET THROUGH, intent ends): a NEW
     reader-initiated element appeared since arming — a durable user flow row
     (`data-chat-flow-kind="user"`), a pending-steering bubble
     (`data-pending-steering`), or a submission echo
     (`data-submission-echo`) — i.e. the bundle's "show me my message" jump;
     or a trusted click on the scroller's back-to-bottom button (the only
     `<button>` inside the conversation scroller and outside the
     `[data-chat-flow]` column), queued by a capture-phase click listener so
     the button's own `toBottom` write is never reverted even inside the
     intent window.

   The 700 ms window covers the bundle's 500 ms scroll-sample debounce
   (`SCROLL_SAMPLE_INTERVAL_MS = 500`), the only window in which the bundle can
   yank.

3. **The main conversation view glides too.** While the reader is at the
   bottom (follow mode), streamed agent output glides up instead of jumping in
   token chunks: the bundle's follow re-pin is intercepted and handed to an
   exponential chaser (same 70 ms `CHASE_TAU_MS` constant), and both the
   reader's return within the 45 px re-follow zone and the back-to-bottom
   button land with a glide rather than a snap. Any upward reader input stops
   follow mode immediately; a content-growth observer on the scroller re-arms
   a stopped chase while the reader is at the bottom, so a stale bundle
   `atBottom` sample cannot strand the view. Chase writes go through the
   original prototype setter (bypassing the re-pin trap) and land exactly at
   the floor, so the bundle's 500 ms at-bottom bookkeeping stays coherent.
   The chase speed is set **per episode** (`chaseStep` + `st.episode`,
   shared by both chasers): each chase episode — a gap created by one
   content event, closed to the tail — runs at ONE speed, chosen from the
   gap the episode STARTS with (a speed that tracks the shrinking gap
   decays a big swoosh into the slow flat speed in the last ~800 px and
   visibly crawls home — "fast to near the bottom, then slow"):
   - starting gap >= `GAP_FAST_MIN` (800 px): pure exponential (21 % of
     the gap per frame at 60 fps) for the WHOLE episode — opening a long
     session swooshes all the way to the bottom (~0.7 s for 30 000 px),
     no slow tail;
   - starting gap < 800 px: constant `CHASE_MAX_PX` px per 60 fps frame
     (~960 px/s) — a new tool-call row or body block (100–400 px in one
     commit) glides smoothly instead of swooshing.
   Episodes re-classify after each landing and upgrade smooth -> fast
   when a big insertion grows the gap past the threshold mid-episode
   (a large content block is a swoosh, not a crawl; no downgrade, so no
   oscillation).
   Scroll **methods** are shadowed too: a `scrollTo`/`scrollBy`
   call on the scroller bypasses the property trap, so a bottom-targeted
   call made with no armed reader intent (e.g. the turn rail's follow) is
   swallowed and handed to the chaser (glide); every other call passes
   through untouched (rail centering, saved-position restore).
   **Kill switch / rollback:** the `MAIN_SMOOTH_FOLLOW` constant at the top of
   `lib/client.js` — `false` restores the bundle's current snap behavior for
   the main view (the think-row follower keeps working); see Rollback.

## Rollback

The git repo IS the rollback mechanism: every deployed state is a commit.

- Revert to a previous state: `git checkout <sha>` then `pwsh -File
  deploy.ps1` (e.g. `git checkout 3e55717` restores the working
  smooth-think / snap-main state; then refresh the GUI).
- In-place switch: `MAIN_SMOOTH_FOLLOW = false` in `lib/client.js` +
  redeploy turns off only the main-body glide (the chase cap, the method
  shadows and the re-pin intent system are all gated on it — with it off
  every scroll write passes through natively).
- Chase-speed states: `GAP_FAST_MIN = 0` in `lib/client.js` + redeploy =
  pure exponential everywhere (fast swoosh for every gap, including
  streaming inserts); `GAP_FAST_MIN = 9999999` = one flat 960 px/s speed
  for every gap (the all-capped state, whose slow tail on session open
  motivated the episode rule); the constant tunes which gaps swoosh vs
  glide.
- Diagnostics: `DIAGNOSTICS = false` in `lib/client.js` + redeploy silences
  the `[think-ux]` console.debug traces (intent arming, episode
  classification — `FAST episode gap=Npx`, `fast upgrade gap=Npx`,
  `land ep=.. Nms` — uncaught motion > 16 px, native non-intercepted
  writes > 16 px with the caller stack); on while hunting a jank report,
  off to silence.
- Last resort: the pre-feature known-good `client.js` is snapshotted in
  `backup\dsh-think-ux-smooth-think-3e55717\` (workspace, outside the repo).

## Deployment (quickstart in a new environment)

This repo IS the deployable. No build step (plain JS):

```
package.json   name local-dsh-think-ux, dsh.client.platform=web, inject: []
lib/index.js   host half — marker only, apply() no-op
lib/client.js  browser half — all behavior
deploy.ps1     parameterized deployer (SHA-verified, prints profile snippet)
```

One command, from the repo root:

```powershell
pwsh -File deploy.ps1                      # derives root+version from $env:DSH_HOME
pwsh -File deploy.ps1 -DshRoot 'C:\dsh' -Version '0.1.5-rc.2'  # explicit
```

It copies the plugin byte-for-byte into `<root>\plugins\dsh-think-ux\`
(upgrade-surviving source of truth) and
`<root>\versions\<ver>\plugins\dsh-think-ux\` (the copy the profile loads),
verifies SHA256 parity, and prints the profile state. If the web profile
`<root>\home\<ver>\profiles\web\cordis.patch.yml` lacks the insert row, add the
snippet it prints:

```yaml
- insert:
    - id: dsh-think-ux
      name: file:///<root-as-file-uri>/versions/<ver>/plugins/dsh-think-ux/lib/index.js
```

Then refresh the GUI (the profile insert is picked up on reload; no other
restart needed). On a DSH version upgrade: rerun `deploy.ps1 -Version
<newver>` and re-add the insert row for the new version dir (the top-level
`plugins\` copy survives the upgrade untouched).

## Constraints honored

- No `@deepseek-ai/*` requires; `inject: []` (pure DOM, no bundle services).
- No bare `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`/`fetch` —
  those globals are withheld from dynamic client packages by the runner's
  closure traps. Timed behavior uses `Date.now()` + `requestAnimationFrame` +
  MutationObserver only.
- `ctx.effect(callback, label)` is a context verb and needs no service
  declaration; unload cascades the effect cleanup (observer, listeners, maps).
- Selectors are stable attributes only (`data-conversation-scroll`,
  `data-variant`, `data-state`, `data-expanded`, `data-disclosure-row`,
  `[hidden]`) — never hashed CSS-module class names.

## Residual risks (honest)

- **Selector stability.** The behavior depends on the chat package keeping
  `data-variant="think"` / `data-state` / `data-expanded` /
  `data-disclosure-row`. These are documented component-attribute names, not
  build hashes, but a future version could rename them. Failure mode is
  graceful: the plugin simply stops doing anything (no errors, no breakage of
  the host UI).
- **Click-to-toggle assumption.** Expansion is driven by dispatching a click
  because the collapsed body unmounts (no `keepContentWhenOpen`); if a future
  build keeps content mounted and exposes a different toggle primitive, the
  synthetic click may double-toggle. Guard: the plugin re-reads `data-expanded`
  before every click and expects exactly the recorded result; an unexpected
  external toggle marks the row as user-controlled and stops touching it.
- **Row identity loss on remount.** Row bookkeeping is keyed by element
  identity. If a row's element is re-created mid-run (parent swap), the new
  element loses `userToggled` history: a user-opened row that comes back
  already open is taken over as managed (no click needed) and auto-collapsed
  on settle — the plugin's default policy, not the user's choice. In
  0.1.5-rc.2 this is not reachable in normal operation: the bundle shares one
  keyed renderer instance across streaming/settled/interrupted, the
  in-page "container" change is a `hidden`-attribute toggle on the same
  wrapper, and any true remount starts collapsed (local `useState(false)`),
  which the plugin re-manages (re-expand while running, collapse on settle).
  The takeover branch makes the loss degrade to "default policy" instead of
  "stuck expanded".
- **Nested preview scroller.** The capped body is a hidden-scrollbar scroller
  nested inside the main conversation scroller. A reader wheel/touch up
  inside the preview bubbles to the main scroller's listeners and can arm the
  700 ms intent window — the desired semantics (reading up anywhere pauses the
  main-view yank), but the two scroll layers share the intent system. The
  re-pin trap only watches the MAIN scroller's `scrollTop`; preview scrolling
  never passes through it and is unaffected by intent state. If a future
  bundle adds its own per-row scroll handling, the smooth follow degrades to
  plain (janky) auto-scroll or none — the row features are unaffected.
- **Capped preview line count.** The 24-line cap is computed from the bundle's
  secondary-content line-height token; if a future version changes that token
  the cap drifts by a fraction of a line (cosmetic only — the box stays
  bounded either way). The fade mask is clamped (`min`/`max` stops) so short
  bodies (fewer than ~2 lines) degrade to a symmetric fade instead of an
  inverted gradient.
- **Write-path assumption.** The re-pin trap sees JS property assignments
  (`el.scrollTop = x`); the scroll **methods** (`scrollTo`/`scrollBy` on the
  bound scroller) are shadowed, so a bottom-targeted call with no armed
  reader intent is also handed to the glide. Together they cover every
  programmatic scroll in 0.1.5-rc.2 (toBottom, followRef, land-on-row,
  saved-position restore, turn-rail `scrollTo`). If a future version
  switches the follow to `scrollIntoView` (or another API), re-pins bypass
  both layers and the yank becomes visible again (the row features are
  unaffected; with `DIAGNOSTICS` on, the uncaught motion is named in the
  console). Native reader scrolling is never affected either way.
- **Bottom-out nudge is a real (small) jump.** A downward arrival in the
  25–45 px band pulls the view to the true bottom (≤45 px). That is the
  requested 45 px re-follow semantics — the bundle's own bookkeeping only
  accepts ≤25 px — but a reader who stops exactly in the band is pulled the
  last few pixels instead of being left there. With `MAIN_SMOOTH_FOLLOW` on
  (the default) this pull glides instead of jumping; the kill switch restores
  the snap.
- **Main-body smooth follow (newest feature, first to flip off).** The
  conversation scroller's glide is a per-scroller rAF chaser that writes
  `scrollTop` through the original prototype setter, bypassing the re-pin
  trap — so chase writes are never misclassified and the bundle's 500 ms
  at-bottom sample stays coherent (the chase lands exactly at the floor, 0
  px). Mid-glide the bundle sees "not at bottom", which matches its own
  follow semantics (it stops re-pinning while the reader is technically
  above the floor). The chaser is self-terminating (one rAF chain, no
  timers). If the glide ever misbehaves, `MAIN_SMOOTH_FOLLOW = false` +
  redeploy restores the pre-feature behavior in effect — verified branch by
  branch: with the switch off, every trigger (growth observer, re-pin
  intercept, reader return, jump button) falls back to the original snap
  path, and the only residue is one inert content observer per scroller.
- **Back-to-bottom button identification.** The button is recognized
  structurally (the only `<button>` inside the conversation scroller, outside
  the `[data-chat-flow]` column), not by a stable attribute. If a future
  build puts another button in that spot, that button's jump would also be
  let through while the intent window is open (harmless: it still lands the
  reader at the bottom where they can be).
- **Turn-rail jump near the floor.** A rail/anchor jump that lands the view
  within 25 px of the bottom, made while the 700 ms intent window is open and
  no new reader-initiated element appeared since arming, is indistinguishable
  from a re-pin and gets reverted. Rare combination; jumping again works.
- **Cosmetic flicker.** A reverted re-pin still runs the bundle's `toBottom`
  side effects (`setAtBottom(true)`, active-turn update) before the restore, so
  the "jump to bottom" affordance can flicker once per revert; the bundle's own
  500 ms sample heals it.
- **Re-pin revert window.** The 700 ms intent TTL covers the bundle's 500 ms
  scroll-sample debounce (the only window in which the bundle can yank). A
  re-pin arriving just after TTL expiry is not reverted (by design — the reader
  may have stopped moving and follow should resume).
- **Upgrade path.** The bundle is pristine (verified by SHA against
  `state-registry.txt`); the plugin is the sole layer. On a DSH version
  upgrade: the top-level `plugins\dsh-think-ux\` survives; recopy it into the
  new `versions\<ver>\plugins\` dir and re-add the profile insert row pointing
  at the new version-dir copy. If the new version's scroller no longer uses
  plain `scrollTop` assignments, the scroll-intent half degrades to
  bundle-default behavior (rows unaffected).
