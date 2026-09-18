# dsh-think-ux

Smooth "thinking" experience for the DeepSeek Harness (dsh) Web UI: while a
model reasons, its think row expands as a capped 24-line preview that glides
to the bottom as text streams in; when reasoning settles, the preview
collapses with a short height animation instead of a one-frame ~490 px
jump. The main conversation view follows the same way — streamed output
glides up (long-session opens swoosh), and a `scrollTop` write trap makes
reader-vs-bundle scroll intent unambiguous, so the view glides instead of
snapping.

Pure DOM client plugin: no bundle changes, no services, no network calls,
no timers beyond one settle animation. Verified against DSH 0.1.5-rc.2.

[![awesome-dsh](https://img.shields.io/endpoint?url=https%3A%2F%2Fawesome-dsh-plugin.com%2Fbadge.svg)](https://awesome-dsh-plugin.com/)

## Install

```sh
dsh plugin --profile web add dsh-think-ux
```

Then refresh the Web session (the profile layer picks it up on reload).
For another profile: `dsh plugin --profile <name> add dsh-think-ux`.

## Uninstall

```sh
dsh plugin --profile web remove dsh-think-ux
```

Refresh; the Web UI returns to stock behavior. Nothing to clean up.

## Tunable constants (top of `lib/client.js`)

| Constant | Default | Effect |
|---|---|---|
| `CAP_LINES` | 24 | think-preview line cap |
| `CHASE_TAU_MS` | 70 | glide exponential time constant (both chasers) |
| `CHASE_MAX_PX` | 16 | constant glide speed (px per 60 fps frame, ~960 px/s) |
| `GAP_FAST_MIN` | 800 | episode split: starting gap ≥ this = pure exponential swoosh, below = constant glide |
| `COLLAPSE_MS` | 180 | settle-collapse animation duration; `0` = instant unmount |
| `MAIN_SMOOTH_FOLLOW` | true | kill switch for the main-view glide + anchor override + method shadows |
| `READER_INTENT_TTL_MS` | 700 | reader-intent window (covers the bundle's 500 ms sample) |

Any change is a one-line edit + reinstall of the local copy (see Local
development).

It is NOT upgrade-proof. It is verified against DSH 0.1.5-rc.2 and depends
on that version's DOM attributes and client load protocol. Behavioral
assumptions (the selectors, the click-to-toggle row, the bundle's plain
`scrollTop` write path) degrade quietly when broken — the plugin simply
stops doing its thing (see Residual risks). Registration/manifest
mismatches do NOT degrade quietly: the 0.1.0 release shipped a client
registration name that did not match the package name, and that made the
whole Web UI fail to load ("Failed to load plugins", not stock behavior).
If you see that page naming `dsh-think-ux`, you are on 0.1.0 — run
`dsh plugin --profile web update dsh-think-ux` (0.1.0 is deprecated on npm;
0.1.1 fixed it).

## Behavior

1. **Think rows expand while reasoning streams.** Any `[data-variant="think"]`
   row with `data-state="running"` is auto-expanded via a synthetic click on
   its `[data-disclosure-row]` element (React keeps owning the state). When the
   row settles (`data-state="ok"`) the plugin auto-collapses it — unless the
   reader toggled that row themselves; a trusted click on the row hands it over
   permanently (plugin never touches it again for the row's lifetime). The
   collapse plays a short height animation on the capped body
   (`COLLAPSE_MS`, 180 ms) BEFORE the unmounting click: an instant body
   removal drops ~490 px of content in one frame and clamps a
   bottom-pinned reader down by the whole box in one visible jump, while the
   animation lets the browser clamp frame by frame (a smooth slide). The
   animation ENDS via the body's own `transitionend` (guarded by target +
   property); a `COLLAPSE_MS + 300` ms safety timer — started at the
   animation's real start, not the settle — ends it early if the transition
   never completes (hidden tab, cancelled mid-flight, long main-thread
   stall; the early end just skips the tail of the slide). The finish
   clears the transition but KEEPS the inline `height: 0` so the body
   unmounts with zero residue (clearing it first would flash the natural
   full height for a frame under load). A reader toggle during the
   animation cancels it (the body hands back to its natural height); a row
   REMOVED mid-animation (settle + unmount in the same frame) is cleaned up
   by the removal path (the record and listeners do not linger on the
   detached node); `COLLAPSE_MS = 0` restores the instant unmount.
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
   button land with a glide rather than a snap. Turn-rail navigation glides
   too: a right-rail jump to a past turn lands through the bundle's
   `landOnRow` property write, which is identified by its caller stack (not
   its destination), swallowed, and chased to the row with the same episode
   machine; a re-land write while the glide is running (a chunk reflow while
   an unloaded turn loads) retargets it and keeps the episode speed. Any
   upward reader input stops
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
   Browser scroll anchoring (`overflow-anchor`, default `auto`) is
   disabled on each bound scroller while `MAIN_SMOOTH_FOLLOW` is on:
   with the reader pinned at the bottom, an insertion of a large chunk
   (a tool row, a code block) makes the anchoring adjustment shift
   `scrollTop` by the WHOLE chunk in one frame — a native snap, visible
   as a stiff jump, and it fights the 16 px/frame chase. With anchoring
   off, every bottom tracking goes through the episode-speed chase
   (glide for small gaps, swoosh for large ones). The pre-override
   inline value is restored on unbind.
   Scroll **methods** are shadowed too: a `scrollTo`/`scrollBy`
   call on the scroller bypasses the property trap, so a bottom-targeted
   call made with no armed reader intent (e.g. the turn rail's follow) is
   swallowed and handed to the chaser (glide); every other call passes
   through untouched (rail centering, saved-position restore). The
   `scrollTo(x, y)` form reads the SECOND argument as the vertical
   coordinate (the first is horizontal; a single-number call is x-only),
   matching the DOM spec.
   **Kill switch / rollback:** the `MAIN_SMOOTH_FOLLOW` constant at the top of
   `lib/client.js` — `false` restores the bundle's current snap behavior for
   the main view (the think-row follower keeps working); see Rollback.

4. **One active instance per document (singleton takeover).** The cordis
   runner registers this plugin per conversation surface: every in-page
   session switch invalidates + re-loads the module, creating a new plugin
   instance in the SAME document. Left alone, N live instances each run a
   document-wide MutationObserver and bind EVERY conversation scroller, so N
   chaser loops step on the same scroller — the source of the intermittent
   stiff follow (a fresh page has few live instances; after session switches
   it has many). The newest instance takes over the document: it publishes
   itself on `globalThis.__DSH_THINK_UX_LIVE__` and releases its predecessor
   (observer, traps, rAF chasers, write probe, style tag). Teardown is
   idempotent, so the runner's effect cleanup of a superseded instance is a
   no-op.

## Rollback

The git repo IS the rollback mechanism: every deployed state is a commit.

- Revert to a previous state: `git checkout <sha>` then `pwsh -File
  deploy.ps1` (e.g. `git checkout 3e55717` restores the working
  smooth-think / snap-main state; then refresh the GUI).
- In-place switch: `MAIN_SMOOTH_FOLLOW = false` in `lib/client.js` +
  redeploy turns off only the main-body glide (the chase, the method
  shadows, the re-pin intent system and the `overflow-anchor: none`
  override are all gated on it — with it off every scroll write passes
  through natively and the scroller's pre-override anchor value is
  restored on unbind).
- Settle-collapse animation: `COLLAPSE_MS = 0` in `lib/client.js` +
  redeploy = instant unmount on settle (the pre-animation behavior,
  whose one-frame ~490 px clamp jump at each turn boundary was the
  visible stiff snap); any small value is the animation duration.
- Chase-speed states: `GAP_FAST_MIN = 0` in `lib/client.js` + redeploy =
  pure exponential everywhere (fast swoosh for every gap, including
  streaming inserts); `GAP_FAST_MIN = 9999999` = one flat 960 px/s speed
  for every gap (the all-capped state, whose slow tail on session open
  motivated the episode rule); the constant tunes which gaps swoosh vs
  glide.
- Diagnostics: the final build ships with `DIAGNOSTICS = false` and
  `TRACE_SINK_URL = null` — no prototype probe, no console traces, no
  sink POSTs (the ~22k-line hunt log came from the on-state). To hunt a
  jank report: `DIAGNOSTICS = true` +
  `TRACE_SINK_URL = "http://127.0.0.1:3999/"` in `lib/client.js` +
  redeploy, start `trace-sink.cjs` (workspace cleanup-review) to
  collect the log as JSONL on disk, then reproduce. Traces cover intent
  arming, every episode start `episode sc#N fast|smooth gap=Npx`,
  `chase fast frame step=Npx`, `fast upgrade gap=Npx`, `land ep=.. Nms`,
  uncaught motion > 16 px with the isTrusted flag, native
  non-intercepted writes > 16 px with the caller stack; every line is
  mirrored via fire-and-forget POSTs (a missing sink is a silent no-op)
  and carries a 4-char per-instance id (`[think-ux:XXXX]`) so instances
  from different surfaces are separable in the shared log; the lifecycle
  lines `instance up (doc title=...)`, `takeover from instance XXXX` and
  `instance down (XXXX)` show the singleton hand-off.
- Last resort: uninstall (above) — the Web UI falls back to stock behavior.

## Local development (file:// path)

For hacking on the plugin (or for installs that predate the npm package):
no build step (plain JS):

```
package.json   dsh.bundle.patch + dsh.client.platform=web, inject: []
lib/index.js   host half — marker only, apply() no-op
lib/client.js  browser half — all behavior
deploy.ps1     parameterized file:// deployer (SHA-verified, prints profile snippet)
trace-sink.cjs  local HTTP sink for the DIAGNOSTICS mirror (dev only)
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
- No bare `fetch` (the runner's closure trap shadows it with a throwing
  redirect on per-agent (re)loads — the trace mirror goes through
  `window.fetch`). Timer globals (`setTimeout`/`clearTimeout`) ARE
  available in the 0.1.5-rc.2 runner: the settle collapse (`COLLAPSE_MS`)
  uses them, verified at runtime; if a future runner withholds them the
  collapse self-degrades to the instant unmount (try/catch guard).
  Everything else runs on `Date.now()` + `requestAnimationFrame` +
  MutationObserver.
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
- **Row-glide writer identification.** Turn-rail navigation is recognized by
  the writer's caller stack (`landOnRow` / `realizePendingJump`), captured at
  the write. If a future bundle renames these internals, rail jumps stop
  matching and fall back to the bundle's native snap — no breakage, and no
  other behavior is affected. The bundle's anchor-compensation corrections
  (which keep the reader's row stable across prepends) come from a different
  stack and stay instant by construction: gliding a correction would drift
  the view under a reader mid-page.
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
