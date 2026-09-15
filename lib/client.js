/**
 * local-dsh-think-ux — DOM-layer Think-row UX + reader scroll intent.
 *
 * Upgrade-proof replacement for the first-generation bundle patches
 * (think-expand + autoscroll gesture guard):
 *
 *  1. Think rows auto-expand while their reasoning streams
 *     ([data-state="running"]) and auto-collapse when the row settles
 *     ([data-state="ok"]) — unless the reader toggled the row themselves,
 *     in which case the plugin never touches that row again. While
 *     auto-expanded, the body is a capped preview (at most 24 lines,
 *     top/bottom 24 px fades) that a rAF smooth-follower glides to the
 *     tail as text streams in — the "live preview" look instead of a
 *     full-height expansion. A reader scroll up inside the preview pauses
 *     the follow (resuming when they return to the bottom); a reader
 *     toggle lifts the cap (their expansion is full).
 *  2. Reader "reading up" intent suppresses the bundle's follow-to-bottom
 *     via a scrollTop write trap (defineProperty on the scroller). The
 *     bundle's re-pin is a plain JS assignment (el.scrollTop =
 *     el.scrollHeight); every reader input method (wheel, touch,
 *     scrollbar thumb, track click) scrolls natively and never passes
 *     through the JS setter. So a write that lands at the floor while
 *     the reader sits >25 px above it, inside the intent window, is the
 *     bundle's re-pin by construction: it is allowed to land (the
 *     bundle's own bookkeeping stays consistent) and the reader's
 *     position is restored in the same tick — the yank never paints,
 *     and the resulting scroll event makes the bundle's 500 ms sample
 *     heal atBottomRef=false. The reader's own return, in any event
 *     shape, is native and passes straight through: a downward arrival
 *     within 45 px of the floor ends the intent and actively bottoms
 *     out (the bundle's own bookkeeping only re-engages follow at 25
 *     px), and a click on the scroller's back-to-bottom button queues a
 *     one-shot pass for the jump the button performs.
 *
 * Bundle internals relied on (0.1.5-rc.2):
 *  - Think row: [data-variant="think"][data-state][data-expanded]; its body
 *    UNMOUNTS when closed (DisclosureRow keeps no content by default), so the
 *    plugin toggles rows via a synthetic click on the [data-disclosure-row]
 *    element (expandOnRowClick) — React keeps owning the state.
 *  - Scroller: [data-conversation-scroll] (active-column host mode) or the
 *    nearest overflow-y:auto/scroll ancestor (view-local mode).
 *  - The bundle's follow re-pins via plain JS writes
 *    (el.scrollTop = el.scrollHeight in toBottom/followRef) from layout
 *    effects while atBottomRef is true; a reader move only disengages it
 *    after a 500 ms scroll-sample debounce. Native reader scrolling
 *    never passes through the JS property setter, so the trap can
 *    identify re-pins by construction.
 *
 * No timers are used: browser timer globals are withheld from dynamic client
 * packages, and none are needed — row settling is driven by
 * MutationObserver + requestAnimationFrame; plugin-vs-external toggles are
 * told apart by the expected result recorded around each synthetic click.
 */
window.__ModuleLoader__.load({
	id: "local-dsh-think-ux",
	factory: (require) => {
		const module = { exports: {} };

		/* Intent window after an up gesture. The pristine bundle can only
		 * yank while its 500 ms scroll-sample debounce still reports
		 * atBottomRef=true; each reverted re-pin re-schedules that
		 * sample, so the bundle self-heals within the window and 700 ms
		 * covers the real danger window. */
		const READER_INTENT_TTL_MS = 700;
		/* Re-follow zone: a DOWNWARD arrival this close to the floor ends
		 * the reading pause and actively bottoms out. The pristine bundle
		 * only re-engages its follow at 25 px, so without the bottom-out a
		 * reader who stops in the 25–45 px band would strand there. */
		const RE_FLOOR_EPS = 45;
		/* The bundle's own "at bottom" threshold (client.js:
		 * floor - scrollTop <= 25); the trap's re-pin classification band. */
		const AT_BOTTOM_EPS = 25;
		/* Reader-initiated elements that justify the bundle's UNCONDITIONAL
		 * toBottom (appendedUser / appendedSteering / appendedSubmission
		 * branches): durable user flow rows, pending-steering bubbles,
		 * submission echoes. A new one appearing since intent arming marks a
		 * re-pin-shaped write as the intentional "show me my message" jump. */
		const READER_ROWS = '[data-chat-flow-kind="user"],[data-pending-steering],[data-submission-echo]';
		/* Capped preview: auto-expanded (managed) rows show at most this many
		 * body lines, tail-pinned, with top/bottom fades — the live
		 * "streaming preview" look instead of a full-height expansion. */
		const CAP_CLASS = "dsh-think-ux-capped";
		const CAP_LINES = 24;
		const CAP_FADE_PX = 24;
		/* Smooth-follower easing (exponential chase): smaller = snappier.
		 * 70 ms reads as fluid without visible lag behind the stream. */
		const CHASE_TAU_MS = 70;
		/* KILL SWITCH for main-body smooth follow. true: the conversation
		 * scroller glides to the bottom as agent output streams (and on
		 * reader return / jump-to-bottom); false: the bundle's snap-to-bottom
		 * behavior, unchanged. Flip to false and redeploy to roll back the
		 * main-body smoothness while keeping the think-box follower. */
		const MAIN_SMOOTH_FOLLOW = true;
		/* Chase velocity cap (px per 60 fps frame, ~960 px/s): the speed
		 * small/medium gaps close at. Without it, the pure exponential
		 * chase swooshes a new tool-call row or body block (100–400 px
		 * landing in one commit) at 20 %+ of the distance per frame —
		 * it reads as a snap. */
		const CHASE_MAX_PX = 16;
		/* Episode speed rule. Each chase episode (a gap created by one
		 * content event, closed down to the tail) runs at ONE speed,
		 * chosen from the gap the episode STARTS with — not the shrinking
		 * gap: a speed that follows the current gap decays a session-open
		 * swoosh into the slow flat speed in the last ~800 px and visibly
		 * crawls home ("fast to near the bottom, then slow").
		 *  - starting gap >= GAP_FAST_MIN: pure exponential (21 % of the
		 *    gap per frame at 60 fps) for the WHOLE episode — opening a
		 *    long session swooshes all the way to the bottom, smooth
		 *    exponential tail, ~1.5 s even for 30 000 px;
		 *  - starting gap <  GAP_FAST_MIN: constant CHASE_MAX_PX speed
		 *    (~960 px/s) — streaming inserts (a new tool row / body block,
		 *    100–400 px) glide smoothly, no swoosh.
		 * Episodes re-classify after landing and upgrade smooth -> fast
		 * when a big insertion grows the gap past the threshold
		 * mid-episode (never down: no oscillation). Rollback states:
		 * GAP_FAST_MIN = 0 -> pure exponential everywhere (the pre-cap
		 * fast version); GAP_FAST_MIN = 9999999 -> one flat 960 px/s. */
		const GAP_FAST_MIN = 800;
		/* Settle-collapse height animation (ms). When a capped think row
		 * settles and auto-collapses, the body unmounts and ~490 px of
		 * content vanishes in one frame; a bottom-pinned reader is then
		 * clamped down by the whole box in a single jump (the visible
		 * turn-boundary "stiff snap"). Instead, the collapse first plays a
		 * short height animation on the body: the browser clamps the
		 * reader down frame by frame over COLLAPSE_MS, turning the jump
		 * into a smooth slide, and only then does the unmounting click
		 * land. Rollback: COLLAPSE_MS = 0 -> instant unmount (old
		 * behavior). */
		const COLLAPSE_MS = 180;
		/* Diagnostics: console.debug traces of intent arming, episode
		 * classification/landing (FAST episode gap=N px, land ep=.. Nms,
		 * fast upgrade), uncaught motion >16 px, and native
		 * (non-intercepted) scroll writes >16 px with the caller stack.
		 * On while hunting a jank report; flip off + redeploy to silence.
		 * Cheap: fires only on episode starts/landings and
		 * >16 px motions/writes. */
		const DIAGNOSTICS = true;
		/* Trace sink: mirror every [think-ux] trace to a local listener so
		 * the log can be read from disk instead of copy-pasted out of the
		 * console. Plain fire-and-forget POSTs (string body = a CORS
		 * simple request, no preflight); a missing listener is a silent
		 * no-op. Set null to disable the mirror (console only). */
		const TRACE_SINK_URL = "http://127.0.0.1:3999/";

		/* Per-instance tag: the sink merges traces from EVERY browser tab
		 * (each tab loads its own module instance), so every line carries a
		 * 4-char instance id to partition the log by tab. */
		let TAG = "[think-ux]";

		/* The sink mirror must NOT use the bare `fetch` identifier: per-agent
		 * (re)loads of this module run under the runner's closure trap, whose
		 * parameters shadow `fetch` with a throwing teaching redirect — the
		 * try/catch in trace() would then silently kill the mirror for every
		 * instance after the first (the first, profile-loaded instance is
		 * evaluated without the trap, which is why its lines reached the sink
		 * while the others did not). `window.fetch` addresses the real global
		 * on both load paths. */
		const SINK_FETCH = (typeof window !== "undefined" && window !== null
				&& typeof window.fetch === "function") ? window.fetch.bind(window) : null;

		/* ---------------- singleton takeover ----------------
		 * The cordis runner registers this plugin per conversation surface
		 * (agent): every session switch invalidates + re-loads the module,
		 * so several module instances coexist in ONE document. Each instance
		 * has a document-wide MutationObserver + initialScan binding EVERY
		 * [data-conversation-scroll] in the document, so N live instances
		 * run N MutationObservers, N scrollTop traps and N chaser loops on
		 * the SAME scroller — parallel chasers stepping on each other is the
		 * source of the intermittent stiff follow. Fix: only the newest
		 * instance is active; it releases its predecessor on takeover. */
		const LIVE_KEY = "__DSH_THINK_UX_LIVE__";
		const liveSlot = (typeof globalThis !== "undefined" && globalThis !== null) ? globalThis : null;

		/* One diagnostic line: console.debug + sink mirror. */
		function trace(msg) {
			if (!DIAGNOSTICS) return;
			msg = msg.replace("[think-ux]", TAG);
			console.debug(msg);
			if (TRACE_SINK_URL !== null && SINK_FETCH !== null) {
				try {
					SINK_FETCH(TRACE_SINK_URL, { method: "POST",
						body: JSON.stringify({ t: Date.now(), msg: msg }) })
						.catch(function () { /* no sink: console only */ });
				} catch (e) { /* no fetch: console only */ }
			}
		}

		function apply(ctx) {
			if (typeof document === "undefined" || document === null) return;
			/* Instance identity (this tab / this apply): partitions the
			 * shared sink log across tabs. Restored in the effect cleanup. */
			const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
			let iid = "";
			for (let i = 0; i < 4; i++) iid += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
			TAG = "[think-ux:" + iid + "]";
			trace("[think-ux] instance up (doc title=" + (document.title || "?") + ")");

			/* Row bookkeeping (element-keyed; rows unmount freely). */
			const managed = new Set();      /* rows the plugin auto-expanded          */
			const userToggled = new Set();  /* rows the reader toggled: never touch    */
			const rowState = new Map();     /* row -> last seen data-state             */
			const lastToggle = new Map();   /* row -> "expanded"|"collapsed" expected  */
			const collapsing = new Map();   /* row -> { body, timer } settle collapse  */
			/* Scroller bookkeeping. */
			const bound = new Set();
			const scrollerState = new Map();
			let scIndex = 0;        /* diagnostic identity: sc#N per bound scroller */
			let chaseWriting = false; /* suppress the write probe during our own writes */

			/* ---------------- row helpers ---------------- */

			const floorOf = (el) => Math.max(0, el.scrollHeight - el.clientHeight);
			const isScrollable = (el) => {
				const oy = window.getComputedStyle(el).overflowY;
				return oy === "auto" || oy === "scroll";
			};

			/* Cheap (one query): the attributed host, or the node itself as
			 * scroller — the bundle's own view-local fallback. Runs on every
			 * added node, so it stays O(1). */
			function scrollerOf(node) {
				const host = node.closest("[data-conversation-scroll]");
				if (host !== null) return host;
				if (isScrollable(node)) return node;
				return null;
			}

			/* Bounded ancestor walk for the rare case: a think row whose
			 * scroller is a bare overflow div (view-local mode). Rows are few
			 * and far between, so the walk is affordable. */
			function scrollerOfDeep(node) {
				const sc = scrollerOf(node);
				if (sc !== null) return sc;
				let el = node.parentElement;
				let hops = 0;
				while (el instanceof Element && hops < 24) {
					if (isScrollable(el)) return el;
					el = el.parentElement;
					hops++;
				}
				return null;
			}

			function eachThinkRow(node, fn) {
				if (!(node instanceof Element)) return;
				if (node.matches('[data-variant="think"]')) fn(node);
				for (const row of node.querySelectorAll('[data-variant="think"]')) fn(row);
			}

			/* Capped-preview styling. The body is the only following sibling
			 * of [data-disclosure-row] inside the think row root (the
			 * bundle's DisclosureRow renders row + open&&children), so the
			 * structural selector needs no hashed class names. The body is
			 * a hidden-scrollbar scroll box: the smooth-follower (below)
			 * glides it to the tail as text streams in, so the newest
			 * lines stay visible while older ones scroll past, and the
			 * mask fades both ends of the capped window. */
			const capCss = "." + CAP_CLASS + " [data-disclosure-row] + *{"
				+ "box-sizing:border-box;overflow-x:hidden;overflow-y:auto;"
				+ "scrollbar-width:none;-ms-overflow-style:none;"
				+ "max-height:calc(" + CAP_LINES + " * (20px + var(--dsh-content-font-delta-secondary,0px)) + 8px);"
				+ "-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 min(" + CAP_FADE_PX + "px,50%),#000 max(calc(100% - " + CAP_FADE_PX + "px),50%),transparent 100%);"
				+ "mask-image:linear-gradient(to bottom,transparent 0,#000 min(" + CAP_FADE_PX + "px,50%),#000 max(calc(100% - " + CAP_FADE_PX + "px),50%),transparent 100%);"
				+ "}"
				+ "." + CAP_CLASS + " [data-disclosure-row] + *::-webkit-scrollbar{display:none;}";
			const capStyle = document.createElement("style");
			capStyle.id = "dsh-think-ux-capped-style";
			capStyle.textContent = capCss;
			document.head.appendChild(capStyle);

			function capRow(row, on) {
				if (on) row.classList.add(CAP_CLASS);
				else row.classList.remove(CAP_CLASS);
			}

			/* ---------------- capped-preview smooth auto-follow -------------
			 * The capped body is a hidden-scrollbar scroller. One rAF ticker
			 * "chases" each body's bottom edge with exponential easing
			 * (frame-rate independent), so appended streaming text glides
			 * up smoothly instead of jumping in token chunks. A reader
			 * scroll up inside the preview pauses that body's follow
			 * (terminal style); returning within AT_BOTTOM_EPS of the
			 * bottom resumes it. Growth alone fires no scroll event, so a
			 * MutationObserver per body is the "the bottom moved" signal. */
			const follow = new Map(); /* row -> rec { body, mo, onScroll, paused, lastWrite } */
			let chaseRunning = false;
			let chaseTs = 0;
			let followRaf = 0; /* pending rAF id: cancelled on release */

			function bodyOf(row) {
				const d = row.querySelector("[data-disclosure-row]");
				return (d !== null && d.nextElementSibling !== null) ? d.nextElementSibling : null;
			}

			/* One frame's travel toward the target, for a gap of `diff`
			 * px (positive), at the episode's speed (see GAP_FAST_MIN):
			 *  - fast episode: pure exponential — the fast swoosh, whose
			 *    own tail is smooth (no slow crawl in the last ~800 px);
			 *  - smooth episode: constant CHASE_MAX_PX speed;
			 *  - diff <= 2: the exact remainder (lands precisely). */
			function chaseStep(dt, diff, fast) {
				if (diff <= 2) return diff;
				const k = 1 - Math.exp(-dt / CHASE_TAU_MS);
				if (fast) return diff * k;
				return Math.min(diff * k, CHASE_MAX_PX * (dt / 16.667));
			}

			function followFrame(ts) {
				const dt = chaseTs > 0 ? ts - chaseTs : 16;
				chaseTs = ts;
				let live = false;
				for (const rec of follow.values()) {
					const { row, body } = rec;
					if (rec.paused || !(row instanceof Element) || !(body instanceof Element)
							|| !row.isConnected || !body.isConnected) continue;
					const target = Math.max(0, body.scrollHeight - body.clientHeight);
					const diff = target - body.scrollTop;
					if (Math.abs(diff) < 0.5) continue; /* tail reached */
					/* The preview body is capped (~500 px), so it is
					 * always a smooth episode: constant-speed glide. */
					const step = chaseStep(dt, Math.abs(diff), false) * (diff > 0 ? 1 : -1);
					chaseWriting = true;
					try { body.scrollTop = body.scrollTop + step; }
					finally { chaseWriting = false; }
					rec.lastWrite = body.scrollTop;
					live = true;
				}
				if (live) followRaf = requestAnimationFrame(followFrame);
				else { chaseRunning = false; chaseTs = 0; followRaf = 0; }
			}

			function scheduleFollow() {
				if (!chaseRunning) {
					chaseRunning = true;
					chaseTs = 0;
					followRaf = requestAnimationFrame(followFrame);
				}
			}

			function startFollow(row) {
				if (follow.has(row)) return;
				const body = bodyOf(row);
				if (body === null) {
					/* The body mounts with the data-expanded commit; give it
					 * one frame (the hook re-fires on every expand). */
					requestAnimationFrame(() => { if (managed.has(row)) startFollow(row); });
					return;
				}
				const rec = { row: row, body: body, mo: null, onScroll: null, paused: false, lastWrite: null };
				/* Content growth (the stream) moves the bottom with no scroll
				 * event: the observer is the only "catch up" signal. */
				rec.mo = new MutationObserver(scheduleFollow);
				rec.mo.observe(body, { subtree: true, childList: true, characterData: true });
				rec.onScroll = () => {
					/* Echo of our own programmatic write (scroll events are
					 * async): reported position matches our last write. */
					if (rec.lastWrite !== null && Math.abs(body.scrollTop - rec.lastWrite) < 1) {
						rec.lastWrite = null;
						return;
					}
					const max = Math.max(0, body.scrollHeight - body.clientHeight);
					if (body.scrollTop < max - AT_BOTTOM_EPS) rec.paused = true;  /* reader up */
					else { rec.paused = false; scheduleFollow(); }               /* reader back */
				};
				body.addEventListener("scroll", rec.onScroll, { passive: true });
				follow.set(row, rec);
				/* Land on the tail instantly (like a terminal opening);
				 * smoothness is for the growth after. */
				chaseWriting = true;
				try { body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight); }
				finally { chaseWriting = false; }
				rec.lastWrite = body.scrollTop;
				scheduleFollow();
			}

			function stopFollow(row) {
				const rec = follow.get(row);
				if (rec === undefined) return;
				rec.mo.disconnect();
				rec.body.removeEventListener("scroll", rec.onScroll);
				follow.delete(row);
			}

			/* Managed-row lifecycle: the cap class and the follower are two
			 * sides of the same state — every entry/exit goes through here
			 * so they can never desynchronize. */
			function enterManaged(row) {
				managed.add(row);
				capRow(row, true);
				startFollow(row);
			}

			function leaveManaged(row) {
				managed.delete(row);
				capRow(row, false);
				stopFollow(row);
			}

			/** Synthetic click on the row's disclosure element (untrusted). */
			function toggleRow(row, expected) {
				lastToggle.set(row, expected);
				const target = row.querySelector('[data-disclosure-row]') ?? row;
				target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			}

			function maybeExpand(row) {
				if (!row.isConnected || managed.has(row) || userToggled.has(row)) return;
				const state = row.getAttribute("data-state");
				if (rowState.get(row) === "ok") return; /* history row: leave collapsed */
				rowState.set(row, state);
				if (state !== "running") return;
				if (row.hasAttribute("data-expanded")) {
					/* Arrives already open: a re-created element that
					 * preserved its open state (element identity changed,
					 * so no click of ours opened it). Take it over WITHOUT
					 * clicking so the settle auto-collapse still applies.
					 * In 0.1.5-rc.2 this branch is unreachable in normal
					 * operation — a remounted ReasoningRow starts from
					 * useState(false), i.e. collapsed — so it only
					 * future-proofs. A reader click on this element hands
					 * it back immediately (trusted-click capture). */
					enterManaged(row);
					return;
				}
				if (row.closest("[hidden]") !== null) return;  /* process hidden */
				enterManaged(row);
				const mayOpen = () =>
					managed.has(row) && row.isConnected
					&& row.getAttribute("data-state") === "running"
					&& !row.hasAttribute("data-expanded")
					&& row.closest("[hidden]") === null;
				requestAnimationFrame(() => {
					if (!mayOpen()) { leaveManaged(row); return; }
					toggleRow(row, "expanded");
					requestAnimationFrame(() => { /* one retry */
						if (mayOpen()) toggleRow(row, "expanded");
					});
				});
			}

			/* Abort a running settle collapse (the reader re-opened the row,
			 * or the instance releases): stop the timer and hand the body
			 * back to its natural height. */
			function cancelCollapse(row) {
				const c = collapsing.get(row);
				if (c === undefined) return;
				clearTimeout(c.timer);
				collapsing.delete(row);
				if (c.body instanceof Element && c.body.isConnected) {
					c.body.style.transition = "";
					c.body.style.height = "";
					c.body.style.overflow = "";
				}
			}

			function maybeCollapse(row) {
				const state = row.getAttribute("data-state");
				const prev = rowState.get(row);
				rowState.set(row, state);
				if (state !== "ok" || prev !== "running") return;
				if (!managed.has(row) || userToggled.has(row)) return;
				/* Shrink over COLLAPSE_MS BEFORE the unmounting click. An
				 * instant body removal drops ~490 px of content in one
				 * frame; a bottom-pinned reader is then clamped down by
				 * the whole box in one jump (the turn-boundary stiff
				 * snap). With the height animation the browser clamps
				 * frame by frame: the jump becomes a smooth slide. */
				const body = row.hasAttribute("data-expanded") ? bodyOf(row) : null;
				let h = 0;
				if (body instanceof Element && body.isConnected) {
					h = body.offsetHeight;
					body.style.height = h + "px"; /* pin BEFORE leaveManaged
					                                * drops the cap class, so no
					                                * un-capped flash frame */
					body.style.overflow = "hidden";
				}
				leaveManaged(row);
				const finish = () => {
					if (!collapsing.has(row)) return; /* cancelled or already done */
					collapsing.delete(row);
					if (userToggled.has(row)) return;
					if (body instanceof Element && body.isConnected) {
						body.style.transition = "";
						body.style.height = "";
						body.style.overflow = "";
					}
					if (!row.isConnected || !row.hasAttribute("data-expanded")) return;
					toggleRow(row, "collapsed");
				};
				if (COLLAPSE_MS > 0 && h > 2) {
					collapsing.set(row, { body: body, timer: setTimeout(finish, COLLAPSE_MS + 80) });
					requestAnimationFrame(() => {
						const c = collapsing.get(row);
						if (c === undefined || c.body !== body) return;
						if (!(body instanceof Element) || !body.isConnected) return;
						void body.offsetHeight; /* flush the pinned height */
						body.style.transition = "height " + COLLAPSE_MS + "ms ease";
						body.style.height = "0px";
					});
				} else {
					collapsing.set(row, { body: body, timer: 0 });
					requestAnimationFrame(finish);
				}
			}

			/** data-expanded changed: distinguish our own React commit from an
			 *  external (reader or upstream) toggle. */
			function onExpandedChange(row) {
				const now = row.hasAttribute("data-expanded");
				const expected = lastToggle.get(row);
				if (expected !== undefined && (expected === "expanded") === now) {
					lastToggle.delete(row); /* our commit landed */
					if (now && managed.has(row) && !follow.has(row)) startFollow(row);
					return;
				}
				lastToggle.delete(row);
				if (managed.has(row)) {
					userToggled.add(row);
					leaveManaged(row);
				}
				cancelCollapse(row); /* reader re-opened mid-animation:
				                      * restore the body's natural height */
			}

			function forgetRow(row) {
				rowState.delete(row);
				leaveManaged(row);
				userToggled.delete(row);
				lastToggle.delete(row);
			}

			/* Trusted clicks on a Think row are reader intent: that row is
			 * user-controlled from now on (covers pointer and Enter/Space
			 * alike, since the key path has no click to observe). */
			function onDocumentClick(e) {
				if (!e.isTrusted) return;
				const t = e.target;
				if (!(t instanceof Element)) return;
				const row = t.closest('[data-variant="think"]');
				if (row !== null) {
					userToggled.add(row);
					leaveManaged(row);
				}
				/* The scroller's back-to-bottom button: the only <button>
				 * inside the conversation scroller that is OUTSIDE the
				 * content column ([data-chat-flow]). Its click calls the
				 * bundle's toBottom — a JS write through the trap — so a
				 * capture-phase (earlier than the button's own handler)
				 * queue guarantees the reader's explicit jump is never
				 * reverted, even while the intent window is open. */
				const btn = t.closest("button");
				if (btn !== null && btn.closest("[data-chat-flow]") === null) {
					for (const [sc, s] of scrollerState) {
						if (sc.contains(btn)) s.jumpQueued = true;
					}
				}
			}

			/* ---------------- scroller intent + re-pin trap ----------------
			 *
			 * The bundle's follow re-pin is a plain JS write
			 * (el.scrollTop = el.scrollHeight in toBottom/followRef).
			 * Native reader scrolling — wheel, touch, scrollbar thumb,
			 * track click — updates scrollTop inside the browser and
			 * never passes through the JS property setter. So a
			 * defineProperty trap on the scroller's scrollTop identifies
			 * the bundle's re-pin by construction: a write that lands
			 * within AT_BOTTOM_EPS of the floor while the reader sits
			 * more than AT_BOTTOM_EPS above it (inside the intent window)
			 * is a re-pin. It is allowed to land — so the bundle's own
			 * bookkeeping (observedTop, atBottomRef) stays consistent —
			 * and the reader's position is restored in the same tick.
			 * The real change fires a scroll event; the bundle's handler
			 * sees "reader moved", schedules its 500 ms sample, and
			 * flips atBottomRef=false — self-healing. Every reader
			 * return (any device, any event shape) is native, passes
			 * straight through, and re-engages the bundle's follow — a
			 * downward arrival within RE_FLOOR_EPS (45 px) of the floor
			 * ends the intent and actively bottoms out, so the bundle's
			 * own 25 px bookkeeping can re-engage its follow.
			 * Exceptions (re-pin-shaped writes LET THROUGH, intent ends):
			 * a NEW reader-initiated element appeared since arming (a
			 * durable user flow row, a pending-steering bubble
			 * [data-pending-steering], a submission echo
			 * [data-submission-echo]) — the bundle's "show me my
			 * message" jump; or a trusted click on the scroller's
			 * back-to-bottom button (the only <button> inside the
			 * scroller, outside [data-chat-flow]), queued by the
			 * capture-phase click listener before the button's own
			 * handler performs the jump. */

			/* Smooth auto-follow for the MAIN conversation scroller (the
			 * agent output). Mirrors the capped-preview follower: one shared
			 * rAF loop chases each follow-mode scroller's bottom edge with
			 * the episode-speed step (chaseStep + st.episode: a whole
			 * episode runs at one speed — constant for small starting
			 * gaps, fast exponential for large ones — so a session-open
			 * swoosh never decays into a slow crawl near the bottom),
			 * so streamed output glides up instead of jumping in token
			 * chunks. Follow mode is on while the reader is
			 * at the bottom (the bundle's own follow is active) and turns off
			 * the instant the reader scrolls up (arm) or the scroller
			 * unbinds. A per-scroller content observer re-arms a stopped
			 * chase on growth, so a stale bundle atBottom sample can't strand
			 * the view. Chase writes go through st.rawSet (the original
			 * prototype setter), bypassing the re-pin trap. */
			let mainChaseRunning = false;
			let mainChaseTs = 0;
			let mainChaseRaf = 0; /* pending rAF id: cancelled on release */

			function mainChaseFrame(ts) {
				const dt = mainChaseTs > 0 ? ts - mainChaseTs : 16;
				mainChaseTs = ts;
				let live = false;
				for (const [sc, st] of scrollerState) {
					if (!st.follow || st.intentSince !== 0) continue;
					const floor = Math.max(0, sc.scrollHeight - sc.clientHeight);
					const top = sc.scrollTop;
					const diff = floor - top;
					if (diff < 0.5) {
					if (st.episode !== null && DIAGNOSTICS)
						trace("[think-ux] land sc#" + st.id + " ep=" + st.episode + " " +
							Math.round(Date.now() - st.episodeStart) + "ms");
					st.episode = null;
					continue;
				}
					/* Episode speed: chosen ONCE per episode (from the
					 * starting gap) and kept to the tail — so a session-open
					 * swoosh stays fast exponential all the way home
					 * instead of decaying into the slow flat speed in the
					 * last ~800 px (the "fast to near the bottom, then
					 * slow crawl" symptom). Re-classified after each
					 * landing; a gap growing past the threshold
					 * mid-episode upgrades smooth -> fast (a big insertion
					 * is a swoosh, not a crawl; never downgrades, so no
					 * oscillation). */
					if (st.episode === null) {
						st.episode = diff >= GAP_FAST_MIN ? "fast" : "smooth";
						st.episodeStart = Date.now();
						if (DIAGNOSTICS)
							trace("[think-ux] episode sc#" + st.id + " " + st.episode +
								" gap=" + Math.round(diff) + "px");
					} else if (st.episode !== "fast" && diff >= GAP_FAST_MIN) {
						st.episode = "fast";
						if (DIAGNOSTICS)
							trace("[think-ux] fast upgrade sc#" + st.id + " gap=" + Math.round(diff) + "px");
					}
					const next = top + chaseStep(dt, diff, st.episode === "fast");
					st.echo.push(next); /* echo tags for onScrollMove (scroll
					                     * events lag and coalesce, keep a few) */
					if (st.echo.length > 4) st.echo.shift();
					if (DIAGNOSTICS && st.episode === "fast" && next - top > 16)
						trace("[think-ux] chase fast frame sc#" + st.id + " step=" +
							Math.round(next - top) + "px top=" + Math.round(next));
					chaseWriting = true; /* keep the global probe quiet */
					try {
						if (typeof st.rawSet === "function") st.rawSet.call(sc, next);
						else sc.scrollTop = next;
					} finally { chaseWriting = false; }
					live = true;
				}
				if (live) mainChaseRaf = requestAnimationFrame(mainChaseFrame);
				else { mainChaseRunning = false; mainChaseTs = 0; mainChaseRaf = 0; }
			}

			function scheduleMainChase(why) {
				/* Master gate: with the switch off, no trigger (growth
				 * observer, re-pin, reader return, jump button) can start a
				 * chase — every code path falls back to the current snap. */
				if (!MAIN_SMOOTH_FOLLOW || mainChaseRunning) return;
				if (DIAGNOSTICS) trace("[think-ux] chase start via " + (why || "?"));
				mainChaseRunning = true;
				mainChaseTs = 0;
				mainChaseRaf = requestAnimationFrame(mainChaseFrame);
			}

			function arm(sc, st) {
				st.follow = false; /* reader up: stop the smooth follow */
				st.intentSince = Date.now();
				if (DIAGNOSTICS) trace("[think-ux] intent armed sc#" + st.id + " (top=" +
					Math.round(sc.scrollTop) + " floor=" + Math.round(floorOf(sc)) + ")");
				st.top = sc.scrollTop;
				st.floor = floorOf(sc);
				/* Snapshot of reader-initiated elements so the trap can tell
				 * "the reader just sent something" from a plain follow
				 * re-pin. */
				st.readerRows = sc.querySelectorAll(READER_ROWS).length;
			}

			function disarm(st) { st.intentSince = 0; }

			function onScrollMove(sc, st, ev) {
				st.jumpQueued = false; /* a queued button jump either landed
				                      * (the trap consumed it) or was stale */
				const floor = floorOf(sc);
				const top = sc.scrollTop;
				/* Echo of the chaser's own write (scroll events are async and
				 * coalesce): a reported position matching a recent write IS
				 * the chase, not an uncaught motion. */
				let chaseEcho = false;
				for (let i = st.echo.length - 1; i >= 0; i--) {
					if (Math.abs(top - st.echo[i]) < 1) { st.echo.splice(i, 1); chaseEcho = true; break; }
				}
				if (DIAGNOSTICS && Math.abs(top - st.top) > 16 && !chaseEcho) {
					/* tr= is informational only: Chrome marks scroll events
					 * isTrusted=true even for JS scrollTop writes, so the
					 * real JS-write detectors are the trap and the prototype
					 * write probe. tr=1 here = browser-native motion the
					 * trap did not intercept (anchoring, clamps, gestures). */
					trace("[think-ux] uncaught sc#" + st.id + " tr=" +
						(ev && ev.isTrusted ? 1 : 0) +
						" top=" + Math.round(top) +
						" (was " + Math.round(st.top) + ") floor=" + Math.round(floor) +
						" follow=" + st.follow + " armed=" + (st.intentSince !== 0));
				}
				/* scrollTop INCREASING is motion DOWN toward the floor;
				 * DECREASING is motion up toward the first row. */
				if (top > st.top + 0.5) {
					/* Downward motion (the reader coming back to the bottom).
					 * An arrival within the re-follow zone ends the reading
					 * pause AND actively bottoms out: the bundle's own 25 px
					 * bookkeeping only re-engages follow at 25 px, so a
					 * reader stopping in the 25–45 px band would otherwise
					 * strand (bundle atBottomRef stays false, no re-pins).
					 * The bottom-out write passes the trap (intent is
					 * disarmed first) and lands the bundle at 0 px, where
					 * its debounced sample flips atBottomRef back to true. */
					if (floor - top <= RE_FLOOR_EPS) {
						disarm(st);
						st.follow = true;
						st.episode = null; /* re-classify from the current gap */
						if (floor - top > 0.5) {
							if (MAIN_SMOOTH_FOLLOW) {
								if (DIAGNOSTICS)
									trace("[think-ux] re-follow sc#" + st.id + " gap=" + Math.round(floor - top) + "px");
								scheduleMainChase("refollow"); /* glide to the bottom */
							} else sc.scrollTop = sc.scrollHeight; /* current snap */
						}
					}
				} else if (top < st.top - 0.5) {
					/* Upward drift, any device (scrollbar included) — EXCEPT
					 * passive clamps: when content ABOVE the reader shrinks
					 * (a capped think row collapsing on settle), the browser
					 * clamps scrollTop down, which reads as upward motion but
					 * ends AT the floor, not reading away from it. Without
					 * this exclusion every turn boundary (think collapse)
					 * would arm the 700 ms intent window: re-pins reverted,
					 * smooth follow frozen, then a fast stiff catch-up —
					 * the "some segments janky" symptom. A real upward
					 * reading move leaves the at-bottom band within a few
					 * frames and arms on that event. */
					if (floor - top > AT_BOTTOM_EPS) arm(sc, st);
				}
				st.top = sc.scrollTop;
				st.floor = floor;
			}

			/* First scrollTop accessor up the element's prototype chain. */
			function scrollTopAccessor(el) {
				let p = el;
				while (p !== null) {
					const d = Object.getOwnPropertyDescriptor(p, "scrollTop");
					if (d !== undefined && typeof d.get === "function" && typeof d.set === "function") return d;
					p = Object.getPrototypeOf(p);
				}
				return null;
			}

			function bindScroller(sc) {
				if (bound.has(sc) || !(sc instanceof Element)) return;
				bound.add(sc);
				const st = { id: ++scIndex, top: sc.scrollTop, floor: floorOf(sc), intentSince: 0, readerRows: 0, jumpQueued: false, origOwn: undefined, listeners: null, rawSet: undefined, echo: [], episode: null, episodeStart: 0, protoScrollTo: undefined, protoScrollBy: undefined, follow: (sc.scrollTop + AT_BOTTOM_EPS >= floorOf(sc)) };
				scrollerState.set(sc, st);

				/* Browser scroll anchoring (overflow-anchor, default auto):
				 * while the reader is pinned at the bottom, an insertion of a
				 * large chunk (a tool row, a code block) makes the anchoring
				 * adjustment shift scrollTop by the WHOLE chunk in one frame
				 * — a native snap, visible as a stiff jump, and it fights the
				 * 16 px/frame chase. Disabling it routes ALL bottom tracking
				 * through the episode-speed chase (glide or swoosh). */
				st.origAnchor = sc.style.overflowAnchor;
				if (MAIN_SMOOTH_FOLLOW) sc.style.overflowAnchor = "none";

				/* Install the re-pin trap on this element's scrollTop. */
				const desc = scrollTopAccessor(sc);
				if (desc !== null) {
					const get = desc.get;
					const set = desc.set;
					st.rawSet = set; /* smooth-chase writes bypass the re-pin trap */
					st.origOwn = Object.getOwnPropertyDescriptor(sc, "scrollTop");
					Object.defineProperty(sc, "scrollTop", {
						get: function () { return get.call(this); },
						set: function (v) {
							if (st.intentSince !== 0 &&
									Date.now() - st.intentSince <= READER_INTENT_TTL_MS) {
								const top = get.call(this);
								const floor = Math.max(0, this.scrollHeight - this.clientHeight);
								/* The bundle's re-pin writes el.scrollHeight, which
								 * overshoots the floor and the browser clamps to
								 * it — so "lands at the bottom" means the target
								 * is at or beyond floor minus the at-bottom band. */
								if (top + AT_BOTTOM_EPS < floor && v - top > AT_BOTTOM_EPS &&
										v >= floor - AT_BOTTOM_EPS) {
									/* Re-pin-shaped write (only the bundle writes
									 * scrollTop from JS). Let it through when
									 * the READER asked for the bottom:
									 *  - a NEW reader-initiated element appeared
									 *    since arming (durable user flow row,
									 *    pending-steering bubble, submission
									 *    echo) — the bundle's "show me my
									 *    message" toBottom; or
									 *  - a trusted click queued on the
									 *    scroller's back-to-bottom button (the
									 *    only <button> inside the scroller,
									 *    outside [data-chat-flow]). */
									if (st.jumpQueued ||
											this.querySelectorAll(READER_ROWS).length > st.readerRows) {
										st.jumpQueued = false;
										disarm(st);
										st.follow = true;
										st.episode = null; /* re-classify from the current gap */
										if (MAIN_SMOOTH_FOLLOW) {
											if (DIAGNOSTICS)
												trace("[think-ux] jump pass-through sc#" + st.id + " gap=" + Math.round(v - top) + "px");
											scheduleMainChase("jump");
											return; /* glide */
										}
										set.call(this, v);
										return;
									}
									/* Otherwise: a follow re-pin. Let it land,
									 * then restore the reader's position in the
									 * same tick: the intermediate bottom
									 * position never paints (scroll events
									 * coalesce), and the resulting scroll event
									 * makes the bundle's 500 ms sample heal
									 * atBottomRef=false. */
									set.call(this, v);
									set.call(this, top);
									trace("[think-ux] re-pin reverted sc#" + st.id + " (reader at " +
										Math.round(top) + "px, " + Math.round(v - top) + "px jump)");
									return;
								}
							} else if (MAIN_SMOOTH_FOLLOW) {
								const top = get.call(this);
								const floor = Math.max(0, this.scrollHeight - this.clientHeight);
								/* A bundle follow re-pin targets the bottom;
								 * glide to it instead of snapping. */
								if (v >= floor - AT_BOTTOM_EPS && v > top) {
									st.follow = true;
									st.episode = null; /* re-classify from the current gap */
									if (DIAGNOSTICS)
										trace("[think-ux] repin swallow sc#" + st.id + " gap=" + Math.round(v - top) + "px");
									scheduleMainChase("repin");
									return;
								}
							}
							if (DIAGNOSTICS) {
								const t0 = get.call(this);
								if (Math.abs(v - t0) > 16) {
									const f0 = Math.max(0, this.scrollHeight - this.clientHeight);
									/* The trap frame is ours; the caller frames are the
									 * writer's (the bundle's toBottom/followRef/landOnRow
									 * or whatever escaped the intercept). */
									const stk = (new Error().stack || "").split("\n")
										.slice(2, 4).map(function (x) { return x.trim(); }).join(" <- ");
									trace("[think-ux] native write sc#" + st.id + " top=" + Math.round(t0) +
										" v=" + Math.round(v) + " floor=" + Math.round(f0) +
										" armed=" + (st.intentSince !== 0) +
										" stack=" + stk);
								}
							}
							set.call(this, v);
						},
						configurable: true,
					});
				}
				if (DIAGNOSTICS) {
					const cls = String(sc.className).split(/\s+/).slice(0, 3).join(".");
					trace("[think-ux] bind sc#" + st.id + " " + (sc.tagName || "?") + "." + cls +
						" conv=" + (sc.hasAttribute("data-conversation-scroll") ? 1 : 0) +
						" h=" + sc.clientHeight + " top=" + Math.round(sc.scrollTop) +
						" floor=" + Math.round(st.floor) + " trapOK=" + (desc !== null ? 1 : 0));
				}

				/* Shadow the scroller's scroll METHODS: a method call
				 * bypasses the scrollTop property trap, so a follow that
				 * wants the bottom can still snap (e.g. the turn rail's
				 * scroller.scrollTo({top, behavior})). A bottom-targeted
				 * call with no armed reader intent is swallowed and handed
				 * to the chaser (glide); everything else (rail centering,
				 * saved-position restore) passes through untouched. */
				st.protoScrollTo = sc.scrollTo;
				st.protoScrollBy = sc.scrollBy;
				sc.scrollTo = function (a, b) {
					if (MAIN_SMOOTH_FOLLOW && st.intentSince === 0 && st.protoScrollTo !== undefined) {
						const floor = Math.max(0, this.scrollHeight - this.clientHeight);
						const t = (a !== null && typeof a === "object") ? a.top : a;
						if (typeof t === "number" && t >= floor - AT_BOTTOM_EPS) {
							st.follow = true;
							st.episode = null; /* re-classify from the current gap */
							if (DIAGNOSTICS)
								trace("[think-ux] scrollTo swallow sc#" + st.id + " top=" + Math.round(t) + " floor=" + Math.round(floor) + "px");
							scheduleMainChase("stow");
							return; /* glide instead of jump */
						}
					}
					return st.protoScrollTo.apply(this, arguments);
				};
				sc.scrollBy = function (x, y) {
					if (MAIN_SMOOTH_FOLLOW && st.intentSince === 0 && typeof y === "number"
							&& st.protoScrollBy !== undefined) {
						const floor = Math.max(0, this.scrollHeight - this.clientHeight);
						if (this.scrollTop + y >= floor - AT_BOTTOM_EPS) {
							st.follow = true;
							st.episode = null; /* re-classify from the current gap */
							if (DIAGNOSTICS)
								trace("[think-ux] scrollBy swallow sc#" + st.id + " top=" + Math.round(this.scrollTop) + " floor=" + Math.round(floor) + "px");
							scheduleMainChase("sby");
							return; /* glide instead of jump */
						}
					}
					return st.protoScrollBy.apply(this, arguments);
				};

				let lastTouchY = null;
				st.listeners = {
					/* Up gestures arm intent immediately, before the
					 * resulting scroll event, so the trap is already live
					 * if the bundle re-pins in the same frame. Down
					 * gestures need no handling: the reader's return is
					 * native scrolling, invisible to the trap, and the
					 * bottom-arrival scroll event disarms. */
					onWheel: (e) => { if (e.deltaY < 0) arm(sc, st); },
					onTouchStart: (e) => { lastTouchY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : null; },
					onTouchMove: (e) => {
						const y = e.touches && e.touches.length > 0 ? e.touches[0].clientY : null;
						if (y === null) return;
						if (lastTouchY !== null && y > lastTouchY + 4) arm(sc, st); /* finger down = content up */
						lastTouchY = y;
					},
					onTouchEnd: () => { lastTouchY = null; },
					onKeyDown: (e) => {
						if (e.key === "PageUp" || e.key === "Home" || e.key === "ArrowUp") arm(sc, st);
					},
					onScroll: (e) => onScrollMove(sc, st, e),
				};
				sc.addEventListener("wheel", st.listeners.onWheel, { passive: true });
				sc.addEventListener("touchstart", st.listeners.onTouchStart, { passive: true });
				sc.addEventListener("touchmove", st.listeners.onTouchMove, { passive: true });
				sc.addEventListener("touchend", st.listeners.onTouchEnd, { passive: true });
				sc.addEventListener("touchcancel", st.listeners.onTouchEnd, { passive: true });
				sc.addEventListener("keydown", st.listeners.onKeyDown, { passive: true });
				sc.addEventListener("scroll", st.listeners.onScroll, { passive: true });
				/* Growth re-arms a stopped smooth chase: while following
				 * (reader at the bottom), any content change in the scroller
				 * schedules a catch-up frame, so a stale bundle atBottom
				 * sample can't strand the view. */
				st.mainMo = new MutationObserver(() => {
					if (st.follow && st.intentSince === 0) scheduleMainChase("mo");
				});
				st.mainMo.observe(sc, { childList: true, subtree: true, characterData: true });
			}

			/* ---------------- DOM observation ---------------- */

			const mo = new MutationObserver((records) => {
				for (const rec of records) {
					if (rec.type === "childList") {
						for (const n of rec.addedNodes) processNode(n);
						for (const n of rec.removedNodes) forgetNode(n);
						continue;
					}
					const t = rec.target;
					if (!(t instanceof Element)) continue;
					if (t.matches('[data-variant="think"]')) {
						if (rec.attributeName === "data-expanded") onExpandedChange(t);
						maybeCollapse(t);
						maybeExpand(t);
						continue;
					}
					if (rec.attributeName === "hidden") processNode(t); /* process re-revealed */
				}
			});
			function processNode(node) {
				if (!(node instanceof Element)) return;
				/* The added node may BE the scroller, live inside one, or
				 * CONTAIN one (React commits whole subtrees). */
				let sc = scrollerOf(node);
				if (sc === null) sc = node.querySelector("[data-conversation-scroll]");
				if (sc !== null) bindScroller(sc);
				eachThinkRow(node, (row) => {
					const rsc = scrollerOfDeep(row); /* robust across render modes */
					if (rsc !== null) bindScroller(rsc);
					maybeCollapse(row);
					maybeExpand(row);
				});
			}
			function forgetNode(node) {
				if (node instanceof Element) {
					eachThinkRow(node, forgetRow);
				} else if (node instanceof DocumentFragment) {
					for (const row of node.querySelectorAll('[data-variant="think"]')) forgetRow(row);
				}
				/* React removes whole subtrees: the reported removed node is
				 * usually an ANCESTOR of the scroller (the conversation root
				 * on a view switch), never the scroller itself — a check on
				 * the removed node would leak the trap, listeners and state
				 * on every switch. Sweep instead: unbind every tracked
				 * scroller the removal detached from the document. A
				 * re-parented view is re-bound by processNode when its nodes
				 * are added back. */
				for (const sc of [...scrollerState.keys()]) {
					if (!sc.isConnected) unbindScroller(sc);
				}
			}

			function unbindScroller(sc) {
				if (!bound.delete(sc)) return;
				const st = scrollerState.get(sc);
				scrollerState.delete(sc);
				if (st === undefined) return;
				if (DIAGNOSTICS) trace("[think-ux] unbind sc#" + st.id);
				if (st.listeners !== null) {
					sc.removeEventListener("wheel", st.listeners.onWheel);
					sc.removeEventListener("touchstart", st.listeners.onTouchStart);
					sc.removeEventListener("touchmove", st.listeners.onTouchMove);
					sc.removeEventListener("touchend", st.listeners.onTouchEnd);
					sc.removeEventListener("touchcancel", st.listeners.onTouchEnd);
					sc.removeEventListener("keydown", st.listeners.onKeyDown);
					sc.removeEventListener("scroll", st.listeners.onScroll);
				}
				if (st.mainMo !== undefined && st.mainMo !== null) st.mainMo.disconnect();
				/* Drop the method shadows: the prototype's scroll methods
				 * return when the own properties go away. */
				if (st.protoScrollTo !== undefined) delete sc.scrollTo;
				if (st.protoScrollBy !== undefined) delete sc.scrollBy;
				/* Restore the pre-override scroll-anchoring state. */
				if (st.origAnchor !== "") sc.style.overflowAnchor = st.origAnchor;
				/* Remove the trap: restore the pre-existing own descriptor,
				 * or drop the override so the prototype's accessor returns. */
				if (st.origOwn === undefined) delete sc.scrollTop;
				else Object.defineProperty(sc, "scrollTop", st.origOwn);
			}

			function initialScan() {
				for (const sc of document.querySelectorAll("[data-conversation-scroll]")) bindScroller(sc);
				for (const row of document.querySelectorAll('[data-variant="think"]')) {
					rowState.set(row, row.getAttribute("data-state"));
					maybeExpand(row);
				}
			}

			/* ---------------- global scrollTop write probe (DIAGNOSTICS) ----
			 * A pass-through wrapper on the PROTOTYPE scrollTop setter: every
			 * write to ANY element (including ones this plugin does not bind)
			 * is recorded with the writer's stack, so a bottom-pinner that
			 * bypasses the per-scroller trap is named at runtime. Our own
			 * chaser writes are suppressed via chaseWriting. Diagnostic
			 * only; restored in the effect cleanup. */
			function installWriteProbe() {
				let p = (typeof Element !== "undefined") ? Element.prototype : null;
				while (p !== null) {
					const d = Object.getOwnPropertyDescriptor(p, "scrollTop");
					if (d !== undefined && typeof d.set === "function") {
						const origGet = d.get;
						const origSet = d.set;
						Object.defineProperty(p, "scrollTop", {
							get: origGet,
							set: function (v) {
								if (DIAGNOSTICS && !chaseWriting && typeof origGet === "function") {
									try {
										const t = origGet.call(this);
										if (Math.abs(v - t) > 2) {
											const el = this;
											const id = (el.hasAttribute("data-conversation-scroll")) ? "CONV"
												: (el.closest("[data-conversation-scroll]")) ? "IN-CONV"
												: "OTHER";
											const cls = String(el.className).split(/\s+/).slice(0, 2).join(".");
											const stk = (new Error().stack || "").split("\n")
												.slice(2, 4).map(function (x) { return x.trim(); }).join(" <- ");
											trace("[think-ux] proto write " + id + " " +
												(el.tagName || "?") + "." + cls +
												" top=" + Math.round(t) + " v=" + Math.round(v) +
												" stack=" + stk);
										}
									} catch (e) { /* never break the write */ }
								}
								origSet.call(this, v);
							},
							configurable: d.configurable !== false,
						});
						return { proto: p, orig: d };
					}
					p = Object.getPrototypeOf(p);
				}
				return null;
			}

			/* Full teardown, idempotent: called by the effect cleanup AND by
			 * the next instance's takeover. */
			let probe = null;
			let released = false;
			function release() {
				if (released) return;
				released = true;
				TAG = "[think-ux]"; /* release the instance identity */
				/* Kill pending chaser frames FIRST: a released instance's
				 * rAF chain would otherwise keep writing the shared
				 * scroller for at least one frame after the takeover. */
				if (followRaf !== 0) { cancelAnimationFrame(followRaf); followRaf = 0; }
				if (mainChaseRaf !== 0) { cancelAnimationFrame(mainChaseRaf); mainChaseRaf = 0; }
				chaseRunning = false;
				mainChaseRunning = false;
				if (probe !== null) Object.defineProperty(probe.proto, "scrollTop", probe.orig);
				probe = null;
				mo.disconnect();
				document.removeEventListener("click", onDocumentClick, true);
				for (const sc of [...bound]) unbindScroller(sc);
				for (const row of [...collapsing.keys()]) cancelCollapse(row);
				for (const row of [...managed]) leaveManaged(row);
				capStyle.remove();
				managed.clear();
				userToggled.clear();
				rowState.clear();
				lastToggle.clear();
				trace("[think-ux] instance down (" + iid + ")");
			}

			ctx.effect(() => {
				/* Singleton takeover: become the one active instance in this
				 * document and release the previous one (if any). Takeover
				 * happens BEFORE the write probe is installed: releasing the
				 * predecessor restores the prototype scrollTop descriptor it
				 * captured, which would destroy a probe installed after it. */
				if (liveSlot) {
					const prev = liveSlot[LIVE_KEY];
					liveSlot[LIVE_KEY] = { iid: iid, release };
					if (prev !== null && prev !== undefined && typeof prev.release === "function") {
						trace("[think-ux] takeover from instance " + (prev.iid || "?"));
						prev.release();
					}
				}
				probe = DIAGNOSTICS ? installWriteProbe() : null;
				document.addEventListener("click", onDocumentClick, true);
				mo.observe(document.body ?? document.documentElement, {
					subtree: true,
					childList: true,
					attributes: true,
					attributeFilter: ["data-state", "data-expanded", "hidden"],
				});
				initialScan();
				return () => {
					/* Only this instance's slot entry points at release(); if
					 * a newer instance already took over, it owns the slot. */
					if (liveSlot && liveSlot[LIVE_KEY] && liveSlot[LIVE_KEY].release === release) {
						liveSlot[LIVE_KEY] = null;
					}
					release();
				};
			}, "dsh-think-ux: think-row expand/collapse + reader scroll intent");
		}

		module.exports.apply = apply;
		module.exports.inject = [];
		return module.exports;
	}
});
