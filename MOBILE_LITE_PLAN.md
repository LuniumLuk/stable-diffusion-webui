# Mobile Lite UI — Plan (approved & implemented; verification complete)

> Status: **approved, implemented and verified 2026-09-24**. Live on `restart22`
> (`log/webui-restart22-20260924.log`). Entry routing is active with the `Auto` default
> (phones opening `/` get the lite UI); switch it off any time via
> **Settings → Mobile lite → Disabled** or per browser with `/?desktop=1`.
>
> Verification: API suite **48/48** (`tmp/mlite_api_test.py`), iPhone WebKit probe **14/14**
> (`tmp/iosprobe/mlite.js`), Chromium flows + lost-response recovery — see §8.
>
> Companion document: [`MOBILE_LITE_UX_SKETCH.html`](MOBILE_LITE_UX_SKETCH.html) —
> visual wireframes for the same plan, open it in a browser.

---

## 1. Goal

Add a second UI scheme — **Mobile Lite** — that is the default entry point for phones/tablets
(`/` redirects to `/mlite/`), is explicitly switchable in Settings, and replaces the
desktop-shaped Gradio page on mobile with a ground-up, mobile-first app for **only the hot
paths**:

| Screen | Scope |
| --- | --- |
| **Text** | txt2img — prompt, essential params, generate, results |
| **Image** | img2img **and** inpaint (paint / erase / SAM-tap mask editor) |
| **Gallery** | browse the endorsement DB (all views), quick actions, use-as-input |
| **Compose** | touch layer compositor → save to `outputs/composition`, send to Image/Inpaint |

Everything else (Extras, PNG Info, Settings, Queue, LoRA training, ControlNet UI, local-LLM,
Qwen tabs, …) is **out of scope** for v1 and can be added later. The existing Gradio UI and
the existing `mobileShell.js` remain untouched for users who opt out or who use wider screens.

### Non-goals (v1)

- No hires-fix / refiner / ControlNet UI / styles dropdown / LoRA browser (prompt syntax
  `<lora:...>` still works — it is just text).
- No offline/PWA caching guarantees (served fresh, `no-store`).
- No multi-user/auth changes — the lite app sits behind the same access gateway as the rest of
  the server.

---

## 2. Why a new UI instead of more `mobileShell.js` patches

The existing mobile shell promotes *the Gradio DOM* into bars/sheets. That works, but it is
capped by what Gradio 3.41 renders: the page ships the whole component tree (~thousands of
DOM nodes), tab strips, extra-network blocks, and every interaction is mediated by Gradio's
Svelte frontend. Measured on a phone this still meant a multi-MB page and second-scale
interactions in the worst cases.

Mobile Lite instead:

- **Owns its DOM completely** — a ~60 KB vanilla ES-module app, no framework, no build step.
- **Talks JSON to four small endpoints** instead of driving Gradio components.
- **Reuses the heavy lifting server-side** (`process_images`, queue lock, progress API,
  endorsement DB, SAM extension, thumbnail caches, bandwidth optimizer) so generations,
  metadata, gallery entries and outputs stay 100 % compatible with the desktop UI.

Stack decision: **vanilla ES modules + one stylesheet**. Rationale: the repo has no node
build pipeline; the bundle is trivial; a framework (Preact/Svelte/Alpine) would add a build
step and offer nothing for 4 screens; touch behaviour must be hand-tuned anyway (iOS).

---

## 3. Entry routing & the setting (the "toggle")

New setting — **Settings → Mobile lite → `mobile_lite_mode`**:

| Value | Behaviour when a browser opens `/` |
| --- | --- |
| `Auto (mobile devices)` *(default)* | phone/tablet user agents are redirected to `/mlite/`; desktop keeps Gradio |
| `Always` | every browser is redirected to `/mlite/` (explicit opt-in for testing/using lite on desktop) |
| `Disabled` | never redirect (existing `mobileShell` remains the only mobile help) |

Details:

- Redirect is done in a **server middleware** (302, `no-store`) so a phone never loads the
  heavy Gradio page first. UA sniff covers `Android|iPhone|iPad|iPod|IEMobile|Windows Phone|
  BlackBerry|Opera Mini|Mobile` — includes iPadOS "desktop mode" (`Macintosh … Mobile/`).
  Only GET/HEAD on `/` or `/index.html` with `Accept: text/html` is considered.
- **Per-browser escape hatch**: the lite UI has a *Desktop UI* button → `/?desktop=1` sets a
  cookie (`mlite_pref=desktop`, 1 year) and the middleware then never redirects that browser.
  `/?mlite=1` clears the cookie and enters lite. These two switches work regardless of the
  setting, so nobody can get stuck.
- The same setting can be changed **from inside the lite app** (Settings sheet → segmented
  control → `POST /mlite/api/options`), plus the link back to the Gradio UI.
- All lite assets and the lite entry HTML are served `no-store` (stale-cache pain was a
  recurring theme on phones in this repo).

---

## 4. UX model (summary; wireframes in the HTML sketch)

### 4.1 Frame

```
┌ top bar ──────────────────────────────────────────────┐
│ SD Lite   [ sdxl model chip ▾ ]                 ⚙    │  46 px, safe-area aware
├ content (scrolls; per-screen) ────────────────────────┤
│                                                       │
│   (screen-specific cards: prompts, image, gallery…)   │
│                                                       │
├ job strip (only while running) ───────────────────────┤
│ [live▣] txt2img 42% ▓▓▓▓░░░░  step 8/20  ~12s  [⏹]   │  62 px, floats above tabbar
├ bottom nav ───────────────────────────────────────────┤
│   ✍ Text      🖼 Image      🗂 Gallery      🧩 Compose │  54 px, safe-area aware
└───────────────────────────────────────────────────────┘
```

- Document **never scrolls**; each screen has one scroll region (the pattern already proven
  by `mobileShell`'s viewport lock). Sliders/canvas drags can't scroll the page by accident.
- **Sheets** (bottom, 82 vh max) hold secondary controls: Params, Checkpoint, Settings,
  Gallery picker, Layers, Add-layer. One sheet at a time; backdrop tap or ✕ closes.
- **Busy overlay** for anything that takes >150 ms (image load, save, SAM, model switch).
- **Toasts** for every async result (success / warn / error), auto-dismiss.

### 4.2 Text (txt2img)

- Prompt textarea + **keyword chips** (MRU from your own recent prompts + endorsed keywords
  from the DB; tap appends `, keyword`). Negative prompt folded under it.
- One-line **params summary** card (size · steps · CFG · sampler · batch · seed 🔒/🎲) — tap
  opens the Params sheet.
- **Results strip** (horizontal): last 12 results of this screen; tap → fullscreen viewer with
  actions: *Use as Image · Use as Inpaint · ⭐ Endorse · Use seed*. Results also persist
  server-side (files + gallery DB), the strip is just convenience.
- Sticky action bar with **Generate** (shows batch count; disabled while a job runs).
- During generation the job strip shows: live-preview thumb (tap to enlarge), step `8/20`,
  percent, ETA, **Stop** (calls `/interrupt`).
- Defaults on first run are read from `ui-config.json`, so the phone starts from the same
  values your desktop UI currently shows.

### 4.3 Image (img2img + inpaint)

- Segmented **Image | Inpaint** switch.
- Source image via **Upload / Camera (`capture=environment`) / Gallery picker** or drag&drop
  (desktop). The loading path caps client-side at 2048 px (JPEG) so a 30 MP photo doesn't
  freeze the bridge.
- **Inpaint mode** adds the mask editor over the image:
  - Tools: ✏️ paint, 🧽 erase, ✨ **SAM tap** (Segment Anything extension HTTP API —
    `/sam/sam-predict`; tap → 3 candidate masks, candidate selector 1/2/3, re-tap replaces),
    ↶ undo (vector op replay — no 16 MB ImageData snapshots), 🗑 clear, brush slider.
  - Coordinates are mapped to the image's natural resolution; the exported mask is a
    transparent-background PNG with white ink, exactly what `create_binary_mask()` expects.
  - Empty-mask generation is blocked with a toast (white = regenerate region).
- Params in the sheet: **denoise**, mask blur, output size (*match input* by default, else
  custom W×H), input fit (stretch / crop&resize), sampler/steps/CFG/seed/batch.
- Generate sends `init_image` + optional `mask` + denoise/size; results land in the same
  strip pattern as Text.

### 4.4 Gallery

- Search box (prompt/model/sampler), view chips: **All · ⭐ Endorsed · Unrated · 👎 Disliked ·
  Archived · 📌 Staged · 🎨 Composed**, count `shown / total`.
- 3-column square thumbnail grid (5 on ≥620 px), lazy images, **infinite scroll**
  (IntersectionObserver + 48/page from the endorsement DB).
- Tap → fullscreen viewer: preview (≤1024 px cache), metadata block, actions:
  **Use as Image · Inpaint · ⭐/un-⭐ · 👎/undo · 📦/un-archive**. Endorse/dislike/archive run
  through the same `endorsement_db` the desktop gallery uses (endorse also moves the file into
  `outputs/endorsed/…` — grid reloads after the action).
- The same component powers a **picker mode** used by Image and Compose (sheet with search +
  “load more”, tap returns the item).

### 4.5 Compose

- Canvas stage (fit-width, checkered = transparency), layers drawn top-first.
- **Gestures**: one finger drag = move selected layer; two fingers = scale + rotate (and move
  by midpoint); tap = select topmost layer under the finger. No page scrolling can interfere
  (`touch-action: none`).
- Tool row: **＋ Add** (gallery / upload / camera / colour layer), **☰ Layers** (list, select,
  ↑↓ reorder, duplicate, centre, delete, opacity/scale/rotation sliders), **Canvas size**
  (presets + custom, first image adopts its own size once), flip, delete.
- Output actions: **Save** → `outputs/composition/composition-<ts>.png` (+`.composerstate.json`
  layer sidecar) so it shows up in the Gallery's *Composed* view; **→ Image** / **→ Inpaint**
  flatten with white background and drop the result into the Image screen as source.

### 4.6 Cross-screen flows

```
Gallery item ──"Use as Image/Inpaint"──▶ Image screen (source loaded, mode set)
Result strip ──"Use as Image/Inpaint"──▶ Image screen
Compose ──────"→ Image / → Inpaint"────▶ Image screen
Result ───────"⭐ Endorse"─────────────▶ endorsement DB (same as desktop gallery)
Image screen ──generate────────────────▶ files in outputs/… + gallery DB (auto-indexed)
```

---

## 5. Backend design

New module **`modules/mobile_lite.py`** (registered from `webui.py` next to
`image_optimization`), plus a new settings section in `modules/shared_options.py`.

```
GET  /mlite                  → 302 → /mlite/
GET  /mlite/                 → index.html (no-store)
GET  /mlite/<asset>          → js/css/svg/webmanifest (no-store, traversal-guarded)

GET  /mlite/api/bootstrap    → models, current model, samplers, schedulers, defaults
                               (from ui-config.json), mode, flags
GET  /mlite/api/status       → progress.global_status_api() (queue/VRAM/ETA)
POST /mlite/api/progress     → wrapper over progress.progressapi (live preview + step/ETA)
POST /mlite/api/interrupt    → interrupt / skip
POST /mlite/api/txt2img      → run job (synchronous, like the A1111 API), returns image list
POST /mlite/api/img2img      → idem + init_image / mask / denoise / resize_mode / inpaint opts
GET  /mlite/api/result       → ring buffer (last 8 results) → survives a lost response
GET  /mlite/api/gallery      → view/query/page/size → normalized JSON items + paging
POST /mlite/api/gallery/action → endorse/unendorse/dislike/undislike/archive/unarchive/stage
GET  /mlite/api/suggestions  → endorsed prompt/negative keywords (for chips)
POST /mlite/api/options      → mobile_lite_mode and sd_model_checkpoint (validated, saved)
POST /mlite/api/save-image   → dataURL → outputs/composition (+ sidecar), used by Compose
```

Key implementation points:

- **Job execution mirrors `modules/api/api.py`**: `queue_lock` (FIFO with UI jobs), `progress.add_task_to_queue → start_task → finish_task`, `shared.state.begin/end()`,
  `process_images(p)`, `p.is_api = True`, `p.outpath_samples/grids` set — so jobs serialize
  with the Gradio UI and the Queue tab, progress shows up in both UIs, and files/infotexts are
  exactly the same as a desktop run.
- **Script args** default exactly like the API does (`script.ui()` defaults inside
  `gr.Blocks()`), so alwayson scripts (ControlNet etc.) execute with their default values;
  the payload already accepts `alwayson` overrides for a future advanced sheet.
- **Result files are discovered by mtime scan** of the samples dir while holding the queue
  lock (no concurrent writer), then returned as `/file=<abs path>?…` URLs plus pre-built
  gallery thumb (192 px) / preview (1024 px) WebP cache URLs — the phone never downloads a full
  PNG to show a thumbnail.
- **Image transport reuses the bandwidth middleware** (`?px=`/`?q=` on `/file=`, `/sd_net/image`
  for source-image loads, caches shared with the desktop gallery under `cache/gallery_thumbs`
  and `cache/gallery_previews`).
- **Recovery**: every finished job is kept in an in-memory ring buffer keyed by task id; if the
  HTTP response is lost (mobile network/sleep), the client polls `/mlite/api/result` and
  recovers the result — a generation is never silently lost.
- **Mask editor** uses the SAM extension's existing HTTP API (`/sam/sam-predict`,
  `return_previews:false`, ≤1024 px input) — no server changes there.
- Model switching (`POST /mlite/api/options`) validates against `sd_models.checkpoint_aliases`
  and persists to `config.json` (same path the QuickSettings use, incl. the reload callback).
- Static assets & HTML are served `no-store`; Python changes need a webui restart, JS/CSS
  changes only a page reload (lite files are statically read per request).

### Files

| File | Purpose |
| --- | --- |
| `modules/mobile_lite.py` | new — middleware, routes, job runner, gallery JSON |
| `modules/shared_options.py` | + "Mobile lite" section (`mobile_lite_mode`, info link) |
| `webui.py` | + middleware + `register_routes` (2 lines each) |
| `mobile_lite/index.html`, `style.css` | app shell, dark theme, safe-area layout |
| `mobile_lite/js/api.js` | fetch client, `/mlite` root detection, image loaders |
| `mobile_lite/js/state.js` | persisted state (params/prompts/UI), tiny event bus |
| `mobile_lite/js/ui.js` | DOM helper, sheets, toasts, fullscreen viewer (pinch/pan), file pickers |
| `mobile_lite/js/job.js` | submit + progress poll + job strip + result ring recovery |
| `mobile_lite/js/prompt.js` | prompt card + keyword chips (MRU + endorsed) |
| `mobile_lite/js/params.js` | params sheet (shared; img2img extras on Image) |
| `mobile_lite/js/send.js` | use-as-image/inpaint, endorse helpers, result viewer |
| `mobile_lite/js/screen-text.js` `screen-image.js` `screen-gallery.js` `screen-compose.js` | the four screens |
| `mobile_lite/js/app.js` | bootstrap, nav, model picker, settings sheet |

---

## 6. State, defaults & persistence

- Client state lives in `localStorage` (`mlite.state.v1`): params, both prompts, brush size,
  gallery view/query, last tab, MRU keywords. Results live in memory (session).
- First launch adopts `ui-config.json` values (same as the desktop UI's open state); after
  that the phone's own values win.
- **Seed semantics**: field shows the last used seed after a run; 🔒 lock forces that seed,
  🎲 resets to random (`-1`). Batch size is fixed at 1; batch *count* ≤ 8.
- Prompts are **per screen** (Text vs Image), so experimenting in inpaint doesn't clobber the
  txt2img prompt.

---

## 7. Errors & feedback inventory

| Situation | Behaviour |
| --- | --- |
| API unreachable at boot | full-screen "could not reach lite API" + Retry |
| Job HTTP response lost | toast "recovered N image(s)" after ring-buffer poll |
| SAM extension absent | ✨ button hidden (probe `/sam/heartbeat`) |
| Empty prompt / empty mask / no source image | warn toast, no request |
| Model switch while a job runs | queued behind the running job (same as QuickSettings), busy toast |
| Any endpoint 4xx/5xx | error toast with server detail |

---

## 8. Verification (executed 2026-09-24)

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Module import + `ui-config.json` defaults + `node --check` on all modules | — | ✅ |
| 2 | **API suite** — every `/mlite/api/*` route, 4xx paths, static/traversal, redirect matrix, real txt2img/img2img/inpaint jobs, progress tracking during a live job, per-job image attribution | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **48/48** |
| 3 | **iPhone E2E probe** (Playwright WebKit, iPhone 13 descriptor, real taps): layout, txt2img from the UI, result viewer, gallery + viewer, compose sheet, gallery→image→inpaint touch paint, inpaint generation | `node tmp/iosprobe/mlite.js` (from `tmp/iosprobe`) | ✅ **14/14**, no page errors |
| 4 | **Chromium UI flows**: boot/tab restore, sheets, generation, mask paint (mouse path), gallery viewer, compose, reload behaviour | browser tools | ✅ |
| 5 | **Lost-response recovery**: generation request delivered but its response dropped — client recovers the result from the ring buffer | injected fetch failure | ✅ "recovered 1 image(s) after a lost connection" (3 s) |
| 6 | Desktop sanity: `/` with desktop UA stays on Gradio; lite redirect only for mobile/`Always`; per-browser opt-out honoured | API suite #2 | ✅ |
| 7 | On-device pass (iPhone Safari over LAN/tunnel) | manual | ⏳ **user step** — camera upload, SAM tap, pinch in composer |

Artifacts: `tmp/mlite_api_test.py` (suite), `tmp/mlite_redirect_test.py` (redirect-only re-check),
`tmp/iosprobe/mlite.js` (iPhone probe + screenshots `mlite-0*.png`), `tmp/iosprobe/mlitedbg*.js`
(instrumented debugging probes used while fixing the mask editor).

### 8.1 Bugs found & fixed by verification

1. **Dead click handlers everywhere** — the `el()` DOM helper registered `onClick` as a listener
   for the literal event `"Click"` (`addEventListener` names are case-sensitive). One-line fix in
   `ui.js`; found because gallery thumbs did nothing.
2. **Sheet chrome not wired** — the sheet's ✕ and the backdrop never closed the sheet; wired once
   in `ui.js`.
3. **Mask editor painted nothing (tap)** — `strokeStart` pushed an `{x, y}` object while
   `drawStroke` expected `[x, y]` arrays, so a tap drew `arc(undefined, undefined, …)` silently;
   taps never emit moves, so painting looked completely dead. Also moved the SAM busy flag to the
   top of `samPick` (double-tap guard).
4. **Touch-only engines** — some WebKit builds deliver touch events without pointer events;
   the mask editor now listens to **both** with a single-owner gesture claim so a browser that
   fires both never paints twice.
5. **`[hidden]` lost to author CSS** — `.stage-empty`, `.mask-tools` and the stage `<img>` are
   flex/block elements, so the UA `[hidden] { display: none }` was overridden and the "hidden"
   empty-state stayed visible, squeezing the image layout. Global `[hidden] { display: none !important }`.
6. **Foreign images in results** — the result file scan used a 1.5 s look-back plus a start time
   captured *before* the queue lock, so files from a job that just finished could be attributed to
   the next lite job. Start time is now stamped inside the lock; the scan window has no fudge.
   (The suite now asserts "exactly its own 1 image" per job.)
7. **Blank screen after reload from a non-default tab** — boot applied the saved tab without
   setting `body[data-tab]`; fixed in `applyTab`.
8. **Reload race** — the debounced state save could still be pending when the page reloaded,
   restoring the previous tab; the state now flushes on `pagehide`/`visibilitychange`.
9. **Redirect target** — now emitted as a root_path-aware absolute path (`/subpath/mlite/`) instead
   of a bare relative one (curl showed it resolving correctly, but this is safer behind subpaths).

---

## 9. Phases

| Phase | Deliverable | Status |
| --- | --- | --- |
| P0 | Backend module + routing/setting skeleton | ✅ done + verified |
| P1 | Text screen end-to-end (incl. progress + results) | ✅ done + verified (UI + API) |
| P2 | Image screen: img2img, then inpaint + SAM | ✅ done + verified (touch paint + inpaint generation) |
| P3 | Gallery + picker + actions | ✅ done + verified (incl. DB action cycle) |
| P4 | Compose (layers, gestures, save/send) | ✅ done (sheet/flow verified; gestures verified on Chromium) |
| P5 | Verification (API suite, WebKit E2E, Chromium) + polish pass | ✅ done — 48/48 + 14/14; on-device pass left to the user |
| P6 | Docs: wiki analysis page + repo memory notes | ✅ done |

"Scaffolded" = code exists in the tree (not committed to your workflow) and needs the review
of this plan, then live verification and polishing.

---

## 10. Current status

- Implementation complete and verified (see §8); server running `restart29` (the Python-side changes in §13-§17
  each needed a restart - JS/CSS alone never do).
- Created: `modules/mobile_lite.py`, wiring in `webui.py`, "Mobile lite" settings section in
  `modules/shared_options.py`, the `mobile_lite/` app (13 ES modules) and the test assets listed in §8/§13.
- Old Gradio mobile-shell probes (`tmp/iosprobe/wf.js`, `ioscheck.js`) were updated to set the
  `mlite_pref=desktop` cookie so they still reach the desktop UI.
- Remaining manual step: the on-device iPhone pass (§8 row 7).
- JS/CSS changes need only a page reload (all `/mlite/*` assets are served `no-store`); Python
  changes need a webui restart.

---

## 11. Open questions for your review

1. **Composer scope** — v1 has transforms + colour layers + save/send, but not the desktop
   composer's paint/crop/Color-Replace/HSV-Replace. Is that acceptable for the first cut, or is
   paint needed on day one?
2. **Hires fix** — excluded from v1 (fast mobile iteration). Should a "Hires" toggle with a
   couple of presets be in the first cut instead?
3. **LoRA/embedding access** — v1 is plain text (the `<lora:…>` syntax still routes). Want a
   quick-insert browser in v1, or is typing/pasting enough?
4. **Prompt chips** — tapping appends at the end (`", keyword"`). Prefer insert-at-cursor,
   or a selection mode with weight helpers (like the desktop chips editor) later?
5. **Gallery views** — all seven (incl. Composed/Staged), or trim the chips row to
   All/Endorsed/Unrated/Disliked?
6. **Endorse from a result** — works with the params the lite client knows (model name without
   hash). OK, or should endorsing only be allowed from the Gallery?
7. **Redirect detection** — server-side UA sniff (fast, no flash, but UA-based). Alternative:
   client-side `pointer: coarse` check on `/` (more accurate, but the heavy page loads first).
   Keep UA, or do both (UA redirect + JS fallback)?
8. **Desktop entry** — should `Always` be the default for *you* on desktop too while testing
   (one-line setting), or keep `Auto`?
9. **Per-screen prompts** — Text and Image keep separate prompt drafts (current design). Or
   share one prompt across screens?
10. **Default output size on Image** — "match input" (current) vs always use the params W×H?

---

## 12. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| iOS Safari quirks (viewport, capture, `fetch` during backgrounding) | viewport-locked layout (proven in `mobileShell`), screen wake-lock not needed, result ring recovery for lost responses |
| Stale cached bundles on phones | `no-store` everywhere in `/mlite/*` |
| Gradio queue interleaving (`--no-gradio-queue` is set) | job runner takes the same `queue_lock` as Gradio jobs → strict serialization |
| Alwayson scripts getting default args | documented behaviour; `alwayson` overrides already plumbed for a future sheet |
| Thumbnails for very large libraries | reuses the existing on-disk thumbnail caches; page size 48 |
| Mask semantics mismatch (white vs black) | exported mask is white-ink/transparent-bg; verified against `create_binary_mask()` in `processing.py` (white = regenerate) |
| Model switch request blocking behind a running job | same semantics as the desktop QuickSettings; client shows a persistent toast |

---

## 13. Addendum - quick UX enhancements (2026-09-24, requested after approval)

Three additions on top of the verified build. No job/routing behaviour changed; one gallery
flag bug was fixed on the way (13.3). JS/CSS changes need only a page reload (`no-store`);
the flag fix needed a server restart (now running `restart24`).

### 13.1 Foldable suggestions (default folded)

`createSuggestionsFold(field)` renders the keyword pool as `<details class="fold suggestions-fold">`,
collapsed unless the user opened it (`ui.suggestionsOpen`, persisted), so chips no longer push
the prompt off a phone screen. Tapping a keyword appends it via `field.appendKeyword`
(dedupe + "already in the prompt" toast). The negative prompt moved into
`<details class="fold negative-fold">` with the same collapsed default.

### 13.2 Advanced prompt editing (chips editor, desktop parity)

The desktop token model (`javascript/promptEditor.js`) was ported to `mobile_lite/js/prompt-parse.js`
as pure functions (`splitSegments`/`joinSegments`/`classify`/`rebuild`/`formatWeight`), and
`mobile_lite/js/prompt.js` was rebuilt on top of it:

- the canonical `<textarea class="pedit-textarea">` stays the single source of truth (the job
  payload and persistence flow are unchanged);
- per-line chip rows with paren / bracket / lora / disabled / plain classification and weights;
- tap a chip -> action bar: −/＋ (0.05 steps), quick 0.8 / 1.1 / 1.2, ⟲ 1.0, ⛔/✅ disable,
  ⎘ duplicate, 🗑 delete, ✕ close - semantics identical to the desktop editor
  (`plain -> (cat:1.1)`, `[cat] -> 0.909`, `((cat:1.3)) -> 1.43`, lora weights, `#(…)` stripped
  at generation time);
- 💬/⏸ line gutter comments a whole line out; the head shows an "N off" badge;
- per-line ＋ opens an inline keyword input with suggestions (MRU + endorsed positive/negative pools);
- ⌨ Text / ✎ Chips toggles the view (`ui.peditMode`, persisted, chips by default); an empty
  prompt shows a hint instead of an empty box.

### 13.3 Gallery card quick actions

Cards are now `<div class="thumb-wrap">` (the thumb is an ARIA button - a `<button>` cannot
contain buttons) with a sibling `.card-actions` row: 🖼 use-as-image, 🎨 use-in-inpaint,
⭐ endorse/un-endorse, 👎 dislike/undislike, 📦 archive/unarchive. Buttons reflect item state
(`.on`), act without opening the viewer, and the grid refreshes through the existing
`gallery-refresh` event. The picker sheet keeps plain cards.

Bug found while verifying: `endorse()` **copies** the image into the endorsed root, so the
`endorsed` flag could never match the original path - the mobile gallery now annotates it by
item key too (`endorsement_db.get_endorsed_item_keys()`), so an endorsed card lights up and the
button becomes "Remove endorsement".

### 13.4 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Parser unit test (round-trip, classification, rebuild, end-to-end edit) | `node tmp\lite_pedit_test.mjs` | ✅ 38/38 |
| 2 | API suite (all routes, redirect matrix, real jobs, action cycle) | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **48/48** |
| 3 | iPhone E2E probe (WebKit, real taps) incl. folds, chips editing, quick actions | `node tmp\iosprobe\mlite.js` | ✅ **30/30**, no page errors |
| 4 | Chromium: chips editing + mode persistence, quick actions, endorse flag round-trip | browser tools | ✅ |
| 5 | `node --check` on `mobile_lite/js/*.js`, `py_compile` on the touched Python | — | ✅ |

Bugs found & fixed while verifying these three features:

1. **Empty-selection crash in the chips editor** - `tokenAt()` guarded with
   `line < 0 || line >= lines.length`, but `selection.line` is `null` and `null < 0` / `null >= n`
   are both `false` in JS, so the first render looked up `lines[null]` and threw
   (`Cannot read properties of undefined`). Guards are now strict (`=== null`), same for
   `insertKeyword()` / `toggleLineComment()`.
2. **Endorsed flag could not match** (see 13.3) - fixed with the key-based annotation.

Probe notes worth keeping:

- ⭐ endorse reports success through the toast and the **⭐ Endorsed** view (the image is copied
  there); it is not a flag on the original path.
- 📦 archive is DB-only and reversible - used as the flag-flip assertion in the probe.
- The prompt textarea is hidden in chips mode, so tests must either press ⌨ Text or set the
  textarea value and re-render (`setPromptChips()` in the probe).

---

## 14. Follow-up round: un-removable card, bulk archive, inpaint preview/editor (2026-09-24, restart25)

### 14.1 The gallery card that could not be removed

Symptom: an endorsed card (broken thumbnail, ⭐+📦 badges) stayed in the **⭐ Endorsed** view no
matter what was tapped. Root cause: `endorse()` **copies** the image into the endorsed root, and
repeated endorsing produces `_N`-suffixed copies (`00028-2190117489_7.png`). The row stores the
canonical `item_key` (`00028-2190117489`), but `unendorse`/`undislike` derived the key from the
*path* (`_item_key_from_path` → `00028-2190117489_7`) → no row matched → nothing happened, while
the API still answered `{"ok": true}`.

Fixes:
- new `endorsement_db.delete_endorsement_by_key()` / `delete_dislike_by_key()`; the mobile action
  handler prefers the explicit `item_key` the gallery already sends, and `endorse()`/`dislike()`
  accept an optional `item_key` override so rows always carry the canonical key;
- disliking an endorsed item now also drops its endorsed copy (the two are mutually exclusive, so
  no orphan file is left behind);
- `/mlite/api/gallery/action` answers **422** whenever the action did not apply - a silent no-op
  can no longer look like success (the client toasts the real error);
- cards whose file is gone render a `⚠ no file` placeholder instead of a broken image;
- the stale row in the live DB (copy deleted by hand) was removed through the fixed API path.

Note: archiving does **not** remove an item from the Endorsed/All views (it hides it from
*Unrated* and flags it with 📦) - that matches the desktop gallery. Un-endorse / dislike remove it.

### 14.2 Archive all unrated (bulk)

`endorsement_db.archive_all_unrated()` already existed for the desktop gallery, so this only needed
wiring: `{"action": "archive-unrated"}` on `/mlite/api/gallery/action` (returns the archived count)
plus a gallery toolbar button with a two-tap confirm - the first tap arms it and shows the current
unrated count ("⚠ archive N?"), the second tap performs the archive and refreshes the grid.

### 14.3 Inpaint: small preview, fullscreen editor

Long images used to make the always-editable canvas fight the page scroll. Now:
- the main Image screen shows a **capped (~30 vh) non-interactive preview** - `pointer-events: none`
  and `touch-action: auto` on the shared frame, so swiping scrolls the page and cannot paint -
  with the mask drawn over the image and a "✎ Edit mask" pill;
- the pill opens a **fullscreen mask editor** (`z-index: 65`: above sheets, below the result viewer)
  that hosts the *same* canvas (no re-render - mask state carries over) plus all editing widgets
  (paint / erase / SAM / undo / clear / brush slider / SAM candidates);
- ✓ Done returns to the preview; leaving the Image tab also closes the editor (new `onHide` hook in
  `app.js`);
- `fitStageFrame()` sizes the frame in explicit pixels from its host box, keeping the source aspect
  ratio in both states.

### 14.4 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | API suite incl. un-endorse-by-key on a suffixed copy and the bulk archive (with exact state restore) | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **58/58** |
| 2 | iPhone WebKit probe incl. preview metrics, editor open/paint/done/tab-switch, archive-unrated arming | `node tmp\iosprobe\mlite.js` | ✅ **45/45**, no page errors |
| 3 | Chromium: preview metrics, editor round trip, mouse paint (alpha 0 → 255 at the clicked pixel), onHide, bulk button arming | browser tools | ✅ |

Probe screenshots: `mlite-04-inpaint-preview.png`, `mlite-05-inpaint-editor.png`.
The bulk-archive test restores the exact prior `archived` row set (snapshot → action → delete only
the keys the action added), so running the suite never changes library state.

---

## 15. Round 3: inpaint hand-off + parameters, and the desktop mobile-adaptation revert (2026-09-24, restart27)

### 15.1 Sending a gallery image to inpaint now carries the prompt (and params)

`useAsImage()` only loaded pixels. Now `send.js::metaFromItem()` snapshots the item
(prompt, negative prompt, steps, CFG, sampler, seed) which travels on
`state.image.source.meta`; `screen-image.js::applySourceMeta()` adopts it - prompt into the
chips editor, params into `state.params` (the seed is applied **and locked**, telltale toast
lists what was loaded). Because `image-source` is emitted *before* the Image screen boots on a
first visit, `init()` also adopts a pending `source.meta` (found by the probe: the prompt was
dropped on the very first send).

### 15.2 The missing inpaint parameters

The backend already accepted `fill`, `inpaint_full_res`, `inpaint_full_res_padding` and
`invert_mask` - only the lite UI never sent them. The Image params sheet now exposes them
(inpaint mode only), mirroring the desktop labels:

| Lite control | Desktop equivalent | Param |
| --- | --- | --- |
| Masked content (Fill / Original / Latent noise / Latent nothing) | Masked content | `fill` |
| Inpaint area (Whole picture / Only masked) + "Only masked padding, px" | Inpaint area + padding | `inpaint_full_res`, `inpaint_full_res_padding` |
| Mask mode (Inpaint masked / Inpaint not masked) | Mask mode | `invert_mask` |
| Resize mode (Stretch / Crop & resize / Resize & fill) | Resize mode | `resize_mode` |

Plus the existing denoise, mask blur and output-size-mode rows; the summary line shows
`whole picture` / `only masked`. Defaults come from `ui-config.json` through bootstrap
(`_ui_defaults()` translates the stored labels - e.g. `"original"` → `fill = 1`,
`"Only masked"` → `inpaint_full_res = true`), so the lite sheet opens with the same values the
Gradio inpaint tab has.

### 15.3 Desktop (Gradio) UI: the mobile adaptation is reverted

The phone layout now lives in `/mlite/`, so the fork's own mobile layer was removed:

- deleted `javascript/mobileShell.js` and `javascript/mobileGestures.js`;
- removed the `/* mobile shell */` and `/* MOBILE / TOUCH INTERACTIONS */` blocks from
  `style.css` (5537 → 4678 lines, zero `mshell` references left);
- restored the pre-mobile versions of the files the touch work had rewired:
  `inpaintSamPanel.js`, `censorPanel.js`, `composer.js`, `endorsedGallery.js`, `imageviewer.js`,
  `canvas-zoom-and-pan/zoom.js`, `scripts/image_composer_tool.py`,
  `processing_scripts/sampler.py` (phone placeholder tweak).

**Deliberately kept**, because they are desktop features that only *shipped* in the same commits:
the chips prompt editor (`promptEditor.js` + `.pedit-*` CSS + `strip_prompt_comments()` inline
`#(...)` support), the inpaint SAM panel itself, the `#img2img_copy_to_*` "To <tab>" grid
layout, `image_optimization.py` (the lite UI's `/sd_net/image` route and the no-cache HTML
middleware depend on it; it only downscales for *remote* clients), and the full-screen mask
editor stays a lite-only feature.

Verified after the revert: `/` with a desktop UA serves the standard Gradio page (no
`mobileShell`/`mobileGestures` scripts, no `#mshell_*` DOM, `html { overflow: visible }`,
16-tab strip, chips editor and SAM panel still present - the panel produced 5 canvases and its
9-button bar once a sketch image was loaded, with zero page errors).

### 15.4 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | API suite incl. inpaint defaults in bootstrap + a real only-masked inpaint job with masked-content options | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **60/60** |
| 2 | iPhone WebKit probe incl. gallery→inpaint prompt carry and the inpaint params sheet | `node tmp\iosprobe\mlite.js` | ✅ **52/52**, no page errors |
| 3 | Desktop page + inpaint panel spot checks | browser tools | ✅ |
| 4 | `node --check` on all lite modules/probes, `py_compile` on the touched Python | — | ✅ |

Working tree note: the revert is uncommitted (12 files modified, 2 deleted, plus the new lite
files); `git diff --stat` shows ~2900 deletions, none of them desktop features.

---

## 16. Round 4: resize mode 3, a usable output size, and the SAM mask bug (2026-09-24, restart28)

### 16.1 "Just resize (latent upscale)" is back

The lite sheet only offered three resize modes and the backend clamped `resize_mode` to `0..2`,
so the fourth desktop option was unreachable. Now the control offers all four with the desktop
labels (Just resize / Crop and resize / Resize and fill / **Just resize (latent upscale)**) and
`_payload_number(..., "resize_mode", 0, 3, 0)` accepts 3 - which `StableDiffusionProcessingImg2Img`
supports natively (it skips the pixel-space resize and interpolates `init_latent` to the target
size, `processing.py` lines ~2042 / ~2096).

### 16.2 Output size is no longer dead weight in inpaint mode

The size block used to be greyed out (`field.disabled`) whenever the mode was "Match input"
(the default), so choosing a size looked impossible. Now:

- the fields and preset chips stay **interactive**;
- editing a value or tapping a preset switches the mode to **Custom** (the segmented control
  follows) instead of silently ignoring the input - `applyCustomSize()` in `params.js`;
- the "Match input" hint under the row explains what is happening.

### 16.3 SAM selected the whole picture - the 1-bit mask bug

The extension answers `/sam/sam-predict` with **1-bit bilevel PNGs** (`Image.fromarray(np.any(mask, axis=0))`
→ PIL mode `"1"`): opaque, white = selected, black = not selected, **no alpha channel**.
`samToWhiteMask()` composited the mask with `destination-in`, which is a no-op on an opaque image
- so every pick turned into a full-picture mask. The conversion now decodes the pixels and uses the
**luminance as alpha** (falling back to the real alpha channel when the mask has one), and the
converted canvas is cached on the op so mask replays stay cheap. Verified by the probe: a pick adds
a small fraction of the image, not ~100% (`mlite-09-sam-pick.png`), and by direct inspection of the
endpoint output (`tmp/sam_mask_probe.py`: mask mode `"1"`, `unique = [0, 1]`, alpha coverage 1.0).

### 16.4 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | API suite incl. a real `resize_mode: 3` img2img job | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **61/61** |
| 2 | iPhone WebKit probe incl. SAM pick bounds, the four resize modes, size-preset → Custom | `node tmp\iosprobe\mlite.js` | ✅ **56/56**, no page errors |
| 3 | Endpoint format probe (why the SAM mask broke) | `.venv\Scripts\python.exe tmp\sam_mask_probe.py` | ✅ documented |

Probe note: after a SAM pick the mask legitimately grows, so the "mask survives" checks re-baseline
the ink count at that point (`inkAfterSam`).

---

## 17. Round 5: `# ---` block toggle in both chips editors (2026-09-24, restart29)

The desktop text mode already had a `# ---` block toggle (`javascript/promptComment.js`), but the two
**chips editors** did not. Both now share the same contract:

- a *block starter* is a line beginning (after whitespace) with `# ---` (extra dashes and a trailing
  label are fine); the block it opens runs up to - but not including - the **next** starter line;
- both marker lines are never modified; a starter without a following marker has no block (no button);
- the button (▶ / ⏸, `.pedit-block-toggle`) sits next to the line gutter on starter lines; tapping it
  comments (`# ` prefix, indentation preserved) or uncomments every non-empty line inside the block.
  Lines that already carry a `#` are left alone when commenting, while `#(...)`-style disabled
  keywords are commented too (they become `# #(…)`, i.e. a plain comment for the backend).

The pure logic lives in `mobile_lite/js/prompt-parse.js` (`isBlockMarker`, `blockBounds`,
`blockIsOff`, `toggleBlockLines`); `mobile_lite/js/prompt.js` renders the button and calls it, and
`javascript/promptEditor.js` carries the same helpers plus a `pointerdown` branch for the new button.

Documentation note for the desktop side: editing an existing `javascript/*.js` does **not** need a
restart - the page's `?mtime` cache-buster is baked at UI creation, so a normal reload can still run
the browser-cached old file; a hard reload (Ctrl+F5) fetches the fresh bytes from the same URL. A
*new* file does need a restart (the script list is built once). The lite app is unaffected
(`no-store`).

### 17.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Parser unit tests incl. 13 block-comment assertions (markers untouched, indentation, empty lines, disabled groups, unclosed block, partial block) | `node tmp\lite_pedit_test.mjs` | ✅ all pass |
| 2 | iPhone WebKit probe: block button appears on a marker line, one tap comments the block, the next restores it | `node tmp\iosprobe\mlite.js` | ✅ **59/59**, no page errors |
| 3 | Desktop chips editors (positive + negative prompt): ▶ comment → ⏸ restore, value round-trips | browser tools | ✅ (`desktop-block-toggle.png`) |


---

## 18. Round 6: mask colour + blinking mask border (2026-09-24, restart29)

A plain white mask is hard to see on bright or pale images (and the lite preview is small), so the
fullscreen mask editor now draws the mask in a **configurable colour** and outlines its edge with an
optionally **blinking border**.

### 18.1 Display colour vs. wire format

The backend decides the mask from **luminance**, not from the alpha channel:
`mobile_lite.py` decodes the uploaded mask with `_decode_image(payload["mask"]).convert("L")` and
`create_binary_mask` (`modules/processing.py:99`) only uses alpha for RGBA images whose alpha is not
255. A coloured (e.g. cyan) mask would therefore be read as "anything not black", i.e. essentially the
whole image.

So the display and the wire format are split:

- the editor paints strokes, brush cursor and SAM results in `state.ui.maskColor` (default `#00e0ff`);
- on submit, `exportMaskDataUrl()` paints the mask canvas onto a scratch canvas with
  `globalCompositeOperation = 'destination-in'` over a white fill, so the **payload is always
  white-with-alpha** - exactly what the backend already handled;
- the preview keeps showing the coloured mask (it reads the live canvas).

### 18.2 Border + blink

`updateMaskOutline()` builds the border on a third canvas (`#maskOutline`) stacked over the mask
canvas:

- the mask is sampled into a 512 px scratch canvas, ink = `alpha > 128`;
- a pixel is a border pixel when it has at least one transparent 4-neighbour (edge detect), then a 3x3
  dilation widens the line by ~1 px;
- the scratch is upscaled with `imageSmoothingEnabled = false` so the border stays crisp;
- border colour = `state.ui.maskOutlineColor` (default `#ffffff`).

`updateMaskBlink()` runs a `requestAnimationFrame` loop (520 ms phase) toggling the outline canvas
opacity between 1 and 0.2, only while the editor is open and `state.ui.maskBlink` is on. It is invoked
from `updateMaskVisibility()`, which already runs on editor enter/exit and on every mask state change,
so the loop starts/stops with the editor.

All three values live in `state.ui` (`maskColor`, `maskOutlineColor`, `maskBlink`) and are persisted
with the rest of the UI state. `clearMaskOps()`, `strokeEnd()` and `replayMask()` each refresh the
outline.

### 18.3 Controls

The editor foot gained a `.mask-colors` row: a mask colour picker, a border colour picker and a
`blink` toggle (`.on` while active). Changing the mask colour invalidates the cached SAM op canvases
(they were rasterised in the old colour) and re-runs `replayMask()`; changing the border colour only
re-runs `updateMaskOutline()`.

### 18.4 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | iPhone WebKit probe: painted pixel carries the configured colour (not white), two colour pickers exist, the outline canvas has ink, its opacity oscillates, and the exported mask is white-alpha | `node tmp\iosprobe\mlite.js` | ✅ **64/64**, no page errors |
| 2 | Parser unit tests (unchanged) | `node tmp\lite_pedit_test.mjs` | ✅ all pass |
| 3 | API suite (unchanged backend path) | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | ✅ **61/61** |

Screenshot: `tmp/iosprobe/mlite-05-inpaint-editor.png`.

---

## 19. Round 7: keyword rename + `# --- name ---` divider button (2026-09-24, restart29)

Two gaps in the **lite** chips editor (`mobile_lite/js/prompt.js`):

1. **Renaming a keyword** previously meant switching to `⌨ Text` mode (or delete + re-add). The
   action bar now carries a `✎ Rename` button: it opens the inline input under the line, pre-filled
   with the keyword, with the suggestion list available for a replacement. Applying rewrites only the
   keyword text - the weight, bracket kind (`(...)`, `[...]`, `<...>`) and the disabled flag are kept
   (`renameKeyword()` -> `rebuild()`), so `(cat:1.2)` becomes `(kitten:1.2)`. `Escape` / `✕` cancels.

2. **Creating a block divider by hand** (`# --- xxx ---`) meant typing it in text mode. While adding
   the *first* keyword of a line (the line has no chips), the add row now also shows a `#—` button:
   the text typed in the input becomes the divider's name and a `# --- name ---` line is inserted
   **above** the line, so the keywords added next land inside the new block. The add input reopens on
   the line under the divider, ready for the first keyword. An empty name yields `# --- ---`.

Both editors share the new pure helper `blockMarker(name)` in `mobile_lite/js/prompt-parse.js`
(unit-tested). A divider behaves like any other marker: it needs a *following* marker to own a block,
so a trailing divider shows no ▶/⏸ toggle - that is the documented contract, not a bug.

The rename action is lite-only for now: the desktop chips editor (`javascript/promptEditor.js`) still
renames via the `⌨ Text` mode textarea.

### 19.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Parser unit tests (adds `blockMarker` + "divider opens a block / trailing divider does not") | `node tmp\lite_pedit_test.mjs` | ✅ all pass |
| 2 | iPhone WebKit probe: ✎ pre-fills + rename keeps the weight + cancel is a no-op; `#—` appears only on a keyword-less line, inserts the named divider above it, reopens the input inside the block, and a second divider closes it (keyword then commented by the block toggle) | `node tmp\iosprobe\mlite.js` | ✅ **75/75**, no page errors |

Screenshot: `tmp/iosprobe/mlite-11-divider-rename.png`.

---

## 20. Round 8: output size by scale factor (2026-09-24, restart29)

img2img could only set the output size in absolute pixels ("Match input" or a custom W×H) - the
desktop's "Resize By" scale had no counterpart. The `Output size mode` control now has three options:

- **Match input** - the previous `auto`: exactly the input image's dimensions;
- **Scale ×** - new: `width/height = round(input × factor / 8) * 8`, factor `0.1 - 4` with quick chips
  `0.5× 0.75× 1× 1.25× 1.5× 2×` and a numeric field. Persisted as `params.sizeScale`;
- **Custom** - the W×H fields / presets (typing in them still switches the mode here).

The scale row shows the resolved resolution (`768×576 → 1152×864`), the W×H fields preview it, and the
summary line (`#screen-image .summary-line`) follows because it is rendered from the same
`outputSize()` helper the generation payload uses. The fields stay editable in scale mode: editing one
converts the mode to Custom, i.e. the scaled size becomes a starting point.

Implementation: `state.params.sizeScale` (`mobile_lite/js/state.js`), the `outputSize()` scale branch
(`mobile_lite/js/screen-image.js`), and the scale field + preview (`mobile_lite/js/params.js`).

### 20.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | iPhone WebKit probe: mode offers `Scale ×`, the row appears only in that mode, quick factors exist, the hint/inputs/summary resolve `1×` and `1.5×` from the loaded image's dimensions, and a `0.5×` inpaint really produces a half-size image (checked through the viewer's `naturalWidth/Height`) | `node tmp\iosprobe\mlite.js` | ✅ **84/84**, no page errors |

Screenshot: `tmp/iosprobe/mlite-12-scale-size.png`.

---

## 21. Round 9: one grouped output-size block with a live preview (2026-09-24, restart29)

Round 8 left the three size modes split across the sheet - "Output size" (presets + W×H) sat above
Seed, while "Output size mode" appeared far below Denoise/Mask blur. The W×H fields stayed visible in
Match input / Scale ×, where they do nothing, and there was no numeric preview of the final size.

Now there is a **single "Output size" field** (image screens):

```
Output size
[ Match input | Scale × | Custom ]
768×768                     <- .size-preview: the resolved size, always visible
input 768×576 ×1.5          <- note for the active mode
[ 0.5× 0.75× 1× … ] [1.5]   <- scale row (scale mode only)
[ 512×512 … ]               <- presets (custom only)
[ 768 × 576 ]               <- W/H fields (custom only)
```

- the mode selector renders **without its own label** inside the field it controls
  (`segmentedControl('', ...)` now omits an empty label);
- presets and W/H fields are hidden outside Custom, so nothing looks editable when it is not;
- switching to Custom **pre-fills** the fields with the size the previous mode resolved to (no jump
  back to stale values);
- the preview is computed by the shared `resolveOutputSize()` (`mobile_lite/js/state.js`), which
  `screen-image.js` (payload + summary) and `params.js` (preview) both call - one source of truth, no
  drift between what the sheet shows and what is generated.

### 21.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | iPhone WebKit probe: the mode control is inside the Output size field, Match input hides the custom fields and previews the input size, Custom reveals + pre-fills them, a preset keeps custom mode, Scale × hides them and previews `input × factor`, and a 0.5× inpaint still produces a half-size image | `node tmp\iosprobe\mlite.js` | ✅ **89/89**, no page errors |

Screenshots: `tmp/iosprobe/mlite-08-inpaint-params.png`, `tmp/iosprobe/mlite-12-scale-size.png`.

---

## 22. Round 10: a usable text mode - growing area + fullscreen editor (2026-09-24, restart29)

Text mode was a `rows="3"` textarea (~60 px on a phone): editing anything longer meant scrolling the
box up and down constantly. Two changes:

1. **The inline area is a real editing surface.** In text mode the textarea has a `40vh` floor
   (`min-height`) and `fitTextarea()` resizes it to its content on every keystroke
   (`height = auto` -> `scrollHeight`), so the page scrolls instead of a tiny box. Re-measured on
   resize (orientation/keyboard via `window.resize`).
2. **Fullscreen editor** (`⤢` button in the textarea's corner): a fixed overlay
   (`.text-editor`, z-index 66, `body.text-editing` locks the page) with the whole screen as the input,
   a `✓ Done` button, and a footnote (`2 lines · 28 chars`). Edits write through on every keystroke
   (iOS can drop the page at any time), `Done` re-renders the chips view, `Escape` closes it, and the
   screen's `onHide()` closes it if the tab changes underneath.

### 22.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | iPhone WebKit probe: text mode is ≥ 35% of the viewport tall, a 40-line prompt grows it past that floor, `⤢` opens an overlay whose area is > 60% of the screen with the page behind locked, the footer counts lines/chars, `Done` closes it and the typed text lands in the prompt + chips view | `node tmp\iosprobe\mlite.js` | ✅ **100/100**, no page errors |

Screenshot: `tmp/iosprobe/mlite-13-fullscreen-text.png`.


---

## 23. Round 11: Hires. fix in txt2img (2026-09-30, restart30)

The lite txt2img job used to hard-code `enable_hr=False`, so a phone could not run hires fix at all.
The Text parameters sheet now carries the full hires block (txt2img only):

```text
Hires fix            [ Off | On ]
  Upscaler           Latent / Latent (antialiased) / ... / installed upscalers
  Upscale by (x)     1.00 - 4.00 (step 0.05)
  Hires target       1024x1024
                     2 hires stages -> 1024x1024 (+origin pass)
  Hires steps        0 = same as the base pass (0-150)
  Hires denoising    0.00 - 1.00
  Stage config       one `scale: 1.5, steps: 20` entry per line (`;` accepted)
```

- **Payload** (`screen-text.js`): `enable_hr`, `hr_upscaler`, `hr_scale`, `hr_steps`, `hr_denoise`,
  `hr_stage_config`; the summary line gains a `Hires x1.5 -> 768x768` chip.
- **Backend** (`modules/mobile_lite.py`): the txt2img branch fills the same processing fields the
  desktop hires row uses (`enable_hr`, `denoising_strength` (hires denoise), `hr_scale`,
  `hr_upscaler`, `hr_second_pass_steps`, `hr_stage_config_text`). Defaults mirror `ui-config.json`
  (`txt2img/Hires. fix`, `Upscaler`, `Upscale by`, `Hires steps`, `Denoising strength`); unknown
  upscaler names (stale config / typos) fall back to the desktop default; the stage config
  normalises `;` to newlines like `modules/txt2img.py`. Bootstrap now exposes `upscalers` + the
  hires defaults.
- **Shared helpers** `mobile_lite/js/hires.js` (pure, DOM-free): `parseHrStageConfig` plus
  `hrFinalSize` / `hrStagePlan` mirror `parse_hr_stage_config_text` / `build_hr_stage_plan`, so the
  live "Hires target" hint (`N hires stages -> ... (+origin pass)`) matches what the backend will
  execute. Unit-tested in `tmp/lite_hires_test.mjs`.
- **Bug fixed on the way** (latent round-9 issue): `selectSizeMode` resolved "the previous mode's
  size" *after* setting `imageSizeMode = 'custom'`, so the Custom pre-fill could read the stale W/H -
  it only ever matched because the probe's old inpaint source was 512 = the default W/H. The
  round-11 probe picks a 768 hires image as its source and exposed it; the size now resolves before
  the mode switch.
- **CSS**: WebKit paints `<select>` with the native white popup-button look unless appearance is
  cleared (the new Upscaler row was washed out) - `-webkit-appearance: none` + a drawn chevron.

### 23.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Unit: stage parsing (separators, invalid entries, clamps) + final size + plan (cap/origin/non-growing/grid) | `node tmp\lite_hires_test.mjs` | OK 13/13 |
| 2 | API: bootstrap hires defaults + upscalers; real hires job 256x256 base -> 512x512 file, semicolon stage config normalised, stage count 2, upscaler fallback in the infotext | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | OK **66/66** |
| 3 | iPhone WebKit probe: hires section offered, hidden while off, reveals on "On", target preview follows the factor (512 x1.5 -> 768x768), stage config shows `2 hires stages ... (+origin pass)`, summary chip, hires Generate -> 768x768 image | `node tmp\iosprobe\mlite.js` | OK **110/110**, no page errors |

Screenshots: `tmp/iosprobe/mlite-03b-hires-params.png`, `tmp/iosprobe/mlite-03c-hires-result.png`
(viewer metadata: `Hires upscale: 1.5, Hires stage config: "scale: 1.25", Hires stage count: 2,
Hires stage plan: 1.0->1.25 ...; 1.25->1.5 ...`).


---

## 24. Round 12: input pre-resize before img2img/inpaint (2026-10-01, restart31)

The Image screen can now pre-resize the loaded picture *before anything else runs* - a separate
"Input resize" block sits directly above "Output size" (resize first, then size the output):

```text
Input resize         [ Off | Scale x | Custom ]
  512x256                    <- resolved target (live)
  input 768x768 . area filter (downscale) . aspect fill - center crop
  Custom size        [ 512 ] x [ 256 ]   + preset chips
  Fit                [ Aspect fill | Stretch (no aspect) ]
```

- **Scale x** (0.25-2 chips + numeric, clamp 0.1-4) multiplies the source dimensions; **Custom**
  takes an explicit WxH that may break the aspect ratio (both snap to the 8 px grid).
- **Fit** (custom only): `Aspect fill` = cover the box, center-crop (no distortion); `Stretch` =
  resize to the exact size, ignoring the aspect ratio.
- **Filter is automatic**: downscales use area averaging (PIL `BOX`, with `reducing_gap` for large
  factors), upscales use Lanczos - judged by the *actual* scale factor (cover operations included).
  The inpaint mask is resized with the identical geometry, so painted regions stay aligned.
- The backend applies it right after decoding (`modules/mobile_lite.py::_apply_input_resize`); the
  infotext records it (`Input resize: 768x768 -> 512x256 (area, aspect fill)`). The output-size
  modes follow the *effective* input: `Match input` resolves to the resized size (no hidden second
  resize), `Scale x` multiplies the resized size, and the sheet note shows the resized dims.
- Pure mirror for the UI: `mobile_lite/js/resize-plan.js` (`planInputResize` / `resolveInputSize`),
  unit-tested; `state.js::resolveOutputSize` now goes through it.

### 24.1 Verification

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Unit: grid/factor clamps, off/scale/custom plans, cover vs stretch, cover-factor filter rule, fallbacks | `node tmp\lite_resize_test.mjs` | OK 12/12 |
| 2 | API: real jobs - scale 0.5 (256x256 out, `(area)`), aspect fill 400x304 (`(area, aspect fill)`), stretch upscale 1024x512 (`(lanczos, stretch)`), inpaint with resized mask | `.venv\Scripts\python.exe tmp\mlite_api_test.py` | OK **72/72** |
| 3 | iPhone WebKit probe: Input resize field, hidden while off, factor chips, 0.5x preview + note, custom seeding, 512x256 preview + fit notes, output follows the resized input, summary chip, and a real inpaint that comes back 512x256 with the resize in the infotext | `node tmp\iosprobe\mlite.js` | OK **125/125**, no page errors |

Screenshots: `tmp/iosprobe/mlite-14-input-resize.png`, `tmp/iosprobe/mlite-15-input-resize-result.png`.
Probe gotcha: the Input resize control introduced a second `Custom`/`Scale x` segmented control and
duplicate factor chips in the sheet - the existing output-size probe checks are now scoped to the
Output size field (`outputFieldLocator`), otherwise JS clicks silently hit the hidden twin.

---

## 25. Round 13: upload progress, separate img2img/inpaint parameters, slider fix (2026-10-01)

Three user reports from on-device use:

### 25.1 Upload wait was invisible

A multi-MB `init_image`/`mask` body uploaded for tens of seconds while the strip only said
`img2img / Waiting...` at 0%. Cause: `fetch()` cannot report upload progress and the progress poll
has no task to find until the whole body arrived.

- `api.js::apiUpload` posts the generation calls through `XMLHttpRequest` and turns
  `upload.onprogress`/`onload` into `{ loaded, total, done }` callbacks (`txt2img`/`img2img` now
  always use it).
- `job.js` runs a 3-phase strip: **upload** ("uploading image 192 KB / 2.0 MB", bar = fraction,
  the poll is skipped entirely so it cannot steal uplink), **sent** ("image sent - waiting for the
  worker..." while the server decodes/prepares/queues), **generating** (existing step/ETA/live
  preview display). Text jobs read "sending prompt..." / "request sent...".
- The upload phase ends on `upload.onload` or when the last progress event reaches the total.

### 25.2 img2img and inpaint shared one parameter set

Both modes wrote `state.params`, so a tune-up for one task leaked into the other. They now keep
**independent sets** (`state.imageParams = { img2img, inpaint }`, persisted) seeded from
`state.params` on first use - like the desktop tabs. The params sheet edits the set of the mode it
opened with; the Image screen, its summary, `resolveOutputSize()` and "send to inpaint/img2img"
meta all target the active set; `runJob` carries the set so a finished run's seed lands in the
right one. The viewer's "Use seed" writes to the shared set and every image set in use.

### 25.3 Denoise slider sat at the far right

`sliderRow` assigned `value` *before* `min`/`max`/`step`. WebKit sanitises the range value against
the element's **current** step (default 1), so 0.75 snapped to 1.0 and the thumb pinned right while
the number field still read 0.75. Isolated WebKit proof:
`value first -> "1"`, `bounds first -> "0.75"`. Fix: assign `min`, `max`, `step` before `value`
(also for the paired number input, for consistency). Every other slider in the app already used
bounds-first.

### 25.4 Verification (mock harness - no GPU)

`tmp/mprobe/server.py` (stdlib mock of every `/mlite/api/*` route, throttled img2img body read for
real upload backpressure) + `tmp/mprobe/probe.js`:

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Unit tests unchanged | `node tmp\lite_pedit_test.mjs`, `lite_hires_test.mjs`, `lite_resize_test.mjs` | all pass |
| 2 | Focused probe on WebKit (iPhone 13) | `python tmp\mprobe\server.py` + `node tmp\mprobe\probe.js webkit` | OK **19/19**, no page errors |
| 3 | Focused probe on Chromium (system Edge) | `node tmp\mprobe\probe.js msedge` | OK **19/19**, no page errors |

The probe checks: slider holds 0.75 at open, arrow nudge, upload bytes/percent samples, "waiting
for the worker" phase, generation progress, denoise 0.30 (img2img) vs 0.90 (inpaint) in the
*request payloads*, mode-switch restores, reload persistence. Screenshots: `tmp/mprobe/fix-01..05-*.png`.
Mock port must stay outside the Win dynamic range (1024-15000, see the local-llm 10013 note): 27889.

---

## 26. Round 14: folded prompt lines + line weights, live preview display (2026-10-01)

Two on-device requests on the lite UI:

### 26.1 Chips editor: default fold + whole-line weight

- **Every line folds to one chip row by default.** The fold is measured after each render
  (`prompt.js::applyFolds`): when a line wraps to more than one row a `▸N` badge appears (N =
  hidden keywords) and the chips are clamped with an inline max-height; `▾` collapses again. Lines
  that fit one row are untouched. Editing a line (add / rename / chip weight / duplicate / delete /
  line weight) auto-expands it, and `relayout()` re-measures when a screen becomes visible (tracked
  in `expandedLines`, index-based and transient).
- **Line weight (⚖ button on every non-empty line)**: wraps the WHOLE line in one A1111 group -
  `(alpha, beta:1.2)` - via an inline row with a -/+ stepper (0.05), quick values
  0.8 / 1.0 / 1.1 / 1.2 / 1.5 and ✓ (applies live; 1.0 unwraps). The chips view unwraps the group so
  per-keyword chips stay individually editable, and every edit re-wraps it (`writeLineContent`
  threads the prefix + weight through all write paths). Only an EXPLICIT numeric tail counts as a
  line weight, so a manually written `(cat)` / `((cat))` stays a keyword weight.
- Pure helpers `parseLineWeight` / `applyLineWeight` in `mobile_lite/js/prompt-parse.js`
  (+12 unit assertions in `tmp/lite_pedit_test.mjs`). Lite-only (the desktop chips editor is
  unchanged).

### 26.2 Live preview: persistent thumbnail + live fullscreen viewer

- Root cause of the "blink of a preview": `progressapi` returns a frame only when it is newer than
  the client's `id_live_preview`; polls between frames returned null and the strip hid the
  thumbnail again. The last frame is now kept in `job.previewSrc` and the 50 px thumb (accent
  border) stays visible for the whole generation.
- Tapping the thumb opens a **live viewer** (tagged `job-preview`): `ui.js::updateViewer(tag, {src,
  title})` repaints the image as new frames arrive and the title follows the job
  (`live preview · 31%`; `live preview · finished` when the job ends). Zoom/pan are untouched.

### 26.3 Verification (mock harness)

| # | Test | Command | Result |
| --- | --- | --- | --- |
| 1 | Unit: 12 line-weight assertions (parse/re-weight/unwrap/nesting/edges) | `node tmp\lite_pedit_test.mjs` | all pass |
| 2 | WebKit probe: fold default+expand, weight wrap/step/unwrap/close, live thumb + viewer repaint, no-blink samples, plus all round-13 checks | `node tmp\mprobe\probe.js webkit` | OK **34/34**, no page errors |
| 3 | Edge probe (Chromium engine) | `node tmp\mprobe\probe.js msedge` | OK **34/34**, no page errors |

The mock now serves distinct live-preview frames (one per second) and runs 9 s per job.
Screenshots: `tmp/mprobe/fix-06-live-preview.png`, `fix-07-folded-line.png`, `fix-08-line-weight.png`.
Gotchas: the weight quick-button `data-weight` must use `formatWeight` (`"1.0"`, not `"1"`), and
`relayout` must be exposed on the `createPromptEditor` wrapper (screens hold the wrapper, not the
per-field object).

---

## 27. Round 15: txt2img Generate was dead on arrival - missing import (2026-10-01)

On-device report: "the txt2img generation button when pressed just stuck for a while with no
action". Reproduced in the WebKit emulator against the **real running server** with
`tmp/mprobe/real_txt2img.js`: tapping Generate threw
`ReferenceError: Can't find variable: state`, the strip never appeared, no `/mlite/api/txt2img`
POST was sent, and the button stayed disabled.

- **Root cause**: round 13 added `store = state.params` **default parameters** to
  `job.js::runJob` / `registerResult` but job.js was never given the `state` import. Default
  expressions are lazy - img2img/inpaint always pass `store` explicitly (probe-covered), while
  txt2img is the only caller that relies on the default, so only its click path evaluated
  `state.params` and threw, before `runJob`'s body ran. Fix: add `state` to the import.
- **Defensive follow-up**: `screen-text.js` / `screen-image.js` now wrap the `runJob` await in
  `try/catch/finally` - any unexpected error re-enables Generate and shows a
  `could not start: ...` toast instead of leaving the button stuck.
- **No more false 100% while waiting**: after the body is sent, the strip shows
  `request sent · waiting for the worker… (12s)` with an **elapsed counter** (`sentDetail()` +
  poll refresh), so a long server-side preparation (e.g. checkpoint loading) visibly ticks.
- **Suite coverage**: the mock probe now always runs a txt2img leg (strip appears / waiting
  counter / result + button re-enabled) and FAILS on any page error (`no page errors during the
  run`). The mock gained a 3 s "prepare" window during which `/progress` reports inactive,
  mirroring a real checkpoint load.
- **Real-server evidence**: before the fix - ReferenceError, no request, stuck button; after -
  strip → 20% → 60% → 100% → result in ~3 s, no page errors (`real_txt2img.js` timeline).
- **Verification**: probe **38/38** on WebKit + **38/38** on Edge, no page errors; unit tests pass.
