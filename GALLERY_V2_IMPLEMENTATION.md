# Gallery v2 — implementation status

Implements the plan in `GALLERY_V2_REFACTOR_PLAN.html` (see also
`GALLERY_SYSTEM_REPORT.html` for the audit). Landing date: 2026-10-10.

## What landed

| Piece | Module | Notes |
|---|---|---|
| Authoritative store | `modules/gallery_db.py` | schema per plan §4.2/4.3: sources registry, items (promoted columns only + `meta_json`), tag_categories/tags/item_tags with `idx_one_single_per_category` (rating composite), state machine + `archive_expires_at` TTL, state_events, composer_states (zlib), saved_views, legacy_keys, FTS5 `items_fts` |
| Blob store | `modules/gallery_blobs.py` | `cache/gallery_blobs.db`; keys by item id; thumb 192 / preview 1024 webp; media policy table (active thumb+preview, archived thumb-only, trash none); ETag-ready crc32; pack-shard scale path = same interface |
| Sources & parsers | `modules/gallery_sources.py` | registry-driven scan/index for txt2img, img2img, composition, image_maker, qwen, krea2, removebg (variant w/ `-rembg` parent), nano_banana, comic_maker, sana; dependency-free a1111/sidecar parsers |
| Query engine | `modules/gallery_query.py` | 7 core filter dims (time/source/state/tags/resolution/prompt/negative) + extras (aspect, composer, variants, path, kind); search grammar `-exclude`, `"phrase"`, `tag:`, `rating:`, `source:`, `prompt:`, `negative:`; sorts time/resolution/size/random/name; batched tags + `state_totals` |
| Lifecycle | `modules/gallery_lifecycle.py` | hourly sweeper thread: archived → trash after 24 h (endorsed items TTL-protected, expiry refreshed), trash media guarantee, restore guard, empty trash; started from the Gallery v2 tab script |
| Migration | `modules/gallery_migrate.py` | M0 snapshot → M1 schema → M2 rows (resumable cursors) → M3 files/blobs (cache webp import, sidecar absorb, composer absorb, orphan quarantine, sha256-verified hardlinks) → G1/G2 gates; `python -m modules.gallery_migrate all` |
| Dual-write facade | `modules/gallery_bridge.py` + hooks in `modules/endorsement_db.py` | every legacy mutation mirrors into gallery.db (ratings, states, captions, index, trash); `read_sidecar_metadata` falls back to the DB; endorse now hardlinks (`GALLERY_ENDORSE_MODE=link|copy|flag`) |
| Single-item trash | `endorsement_db.trash_item_by_key` / `remove_trash_row` | used by the v2 action bar; deletes original + hardlink alias + cached media, keeps metadata |
| HTTP API | `modules/gallery_api.py` | `/gallery/api/query · action · copy-censored · blob · facets · item · similar · composer · maintenance` (registered in `webui.py`) |
| UI v2 | `scripts/gallery_v2_tab.py` + `javascript/galleryV2.js` + `.gv2-*` CSS | Gradio tab "Gallery v2": multi-chip filters, FTS search box, sort picker, live state counts, incremental cards, hover actions, selection + batch bar, detail drawer (preview, meta, workflow tags, history), Load more + infinite scroll, toasts |
| Rollback | env `GALLERY_V2=0` (or Settings → Gallery v2) | old DB + old caches untouched by v2 reads |

## Migration results (real run, 2026-10-10)

- M2 row import: endorsements 4,030 · generated 4,026 · trash 35,449 (old 35,462; unmappable rows differ) ·
  caption rows 637,280 · legacy keys 39,480+ · **items now 41,907** (active 6,458 incl. all scan sources,
  trashed 35,449).
- M3 files/blobs:
  - cache webp imported into `cache/gallery_blobs.db`: 5,137 thumbs + 5,024 previews; 1,122 thumbs regenerated;
    **G2 thumb coverage 100.0% (6,259/6,259)**.
  - `outputs/txt-info` sidecar archive (the fork's `outdir_txt`): **37,296 absorbed**, 428 quarantined;
    near-image `.txt` absorbed 79; composer `.composerstate.json` **1,039 absorbed** (zlib in `gallery.db`,
    files kept until M6); orphan `.txt`/`.json` quarantined 2,735.
  - endorsed copies → hardlinks (sha256-verified): **3,884 converted, 0 mismatches, 8.37 GB freed**
    (plan target was ≈8.54 GB; the rest are endorsements whose original no longer exists).
  - RemoveBG variants: 199 indexed, 191 linked to parents (8 orphans).
  - G1 parity: 199/200 metadata spot checks exact; per-table counts aligned.
  - report: `backups/gallery_migration/reports/gate-report-*.json`.
- Footprint: outputs loose files **44k → 13,246 (images only, −70%)**; total loose (with caches/quarantine)
  74,092 → 26,560 (−64%), and **≈13.2k (−82%)** after the M6 deletions below. `gallery.db` 2.28 GB
  (composer states are base64-of-PNG data — zlib bundles but barely shrinks them), blob store 470 MB.
- Gates: **G2 passed** (coverage 100%, hardlink bytes ≥8 GB). **G3 (1-week soak) running** — dual-write keeps
  both stores fresh. **M6 deferred** (`python -m modules.gallery_migrate m6 --confirm`): deletes the
  quarantine (2.37 GB), absorbed composer originals, legacy cache webp dirs (~365 MB) — run after the soak.
- Live-verified (webui restart71): tab renders 60 cards with blob thumbs, state/source chips with counts,
  trash view = media-free placeholders, `rating:endorsed` search + badges, detail drawer, maintenance buttons;
  no page errors from the v2 code.

## UI upgrade (restart72): combined filters, saved filters, universal actions

- **Combined filter groups** (`FILTER_GROUPS` in `gallery_sources.py`): one-click chips for
  `sdxl` (txt2img+img2img+inpaint), `nonesdxl` (qwen+krea2), `composed` (composition),
  `imagemaker` (image_maker), `otherengines` (removebg+nano_banana+comic_maker+sana),
  plus rating groups `endorsed` / `disliked` / `unrated`. `facets` returns them with live counts;
  chips toggle the underlying filter keys (click again to clear).
- **Saved filters** (`saved_views` table + `/gallery/api/views` CRUD): the views row keeps named
  filter+sort presets — "Save current" opens an inline name form; each chip applies the stored
  filter (controls re-sync), the small `x` deletes it.
- **Universal tagging**: every card exposes endorse/dislike/archive/stage/trash; archived cards
  hide "stage"; trashed cards swap to restore (metadata rollback, requires live media) / purge
  (permanent). Actions go through `/gallery/api/action` and work for all 11 sources
  (legacy stem keys and engine keys both resolve).
- Tests: `tmp/gallery_api_test.py` now covers groups, views CRUD round-trip, and the full
  8-action matrix on composition + image_maker fixtures incl. file deletion on trash and purge
  (71 checks). Totals: 62+26+25+71 = 184.

## Albums: grouping + bundling (webui restart73)

- **Membership** (`albums` table + `items.album_id` column): one item belongs to at most one album
  (adding an item that is already in another album MOVES it, and the toast reports the old album).
  `ALTER TABLE` migration runs automatically on first use of an existing DB (verified live: 41,907
  rows untouched). Album names are UNIQUE COLLATE NOCASE; deleting an album keeps the items
  (memberships are cleared first).
- **Filter**: API `filters.albums` = list of album ids plus the special `"none"` (items without an
  album); `facets().albums` feeds an "Albums" chip row (counts, bundled flag) and a "No album" chip.
  Saved views carry album ids (canonical compare includes them).
- **Default hide**: items that belong to an album are hidden from every normal view (new filter key
  `show_albumed`, default off). They stay visible when (a) an album filter is active — album mode
  shows exactly that album's items and takes precedence over the toggle — or (b) the "Show albumed"
  chip is switched on, or (c) the Trash view is open (`states:['trashed']` is exempt so albumed
  trash rows stay reachable for restore/purge). Saved views persist the toggle.
- **UI** (galleryV2.js): "Albums" row with create (＋ New album), filter chips, a "Show albumed"
  toggle chip (＋ No album), and — when exactly one album is filtered — Bundle/Unbundle/Rename/Delete
  buttons; batch bar gained "Album…" (pick an existing album or type a new name, "Add selected" /
  "Remove selected"); cards show an album badge (📦 prefix when bundled) and the detail drawer lists
  the album. Bug fixed on the way: clicking a card checkbox no longer opens the detail drawer (it
  used to swallow the batch bar).
- **Bundling** (`modules/gallery_albums.py`): "Bundle" compresses every member's original (and its
  hardlink alias) into one verified zip under `cache/gallery_albums/` (manifest.json with path,
  size, sha256, mtime per file; `.part` + `testzip()` before the rename; sha256 of the archive
  stored on the album row). Thumb + preview blobs are guaranteed before any file is removed — the
  gallery keeps browsing normally, but the original file is unreadable/unreachable until
  "Unbundle" restores every entry (sha256-verified, mtimes restored, aliases re-linked) and drops
  the archive. Archived items keep the thumb-only media policy; trashed or file-missing members
  are skipped and reported. Delete is refused on a bundled album (unbundle first); purge-after-bundle
  entries are skipped at unbundle and reported.
- **UI** (galleryV2.js): "Albums" row with create (＋ New album), filter chips, and — when exactly
  one album is filtered — Bundle/Unbundle/Rename/Delete buttons; batch bar gained "Album…"
  (pick an existing album or type a new name, "Add selected" / "Remove selected"); cards show an
  album badge (📦 prefix when bundled) and the detail drawer lists the album. Bug fixed on the way:
  clicking a card checkbox no longer opens the detail drawer (it used to swallow the batch bar).
- Tests: `tmp/gallery_api_test.py` album section — create/duplicate, single-membership move, album +
  no-album filters, default-hide + `show_albumed` + album-mode precedence + trash exemption, facets,
  bundle (originals gone, thumb/preview still served, items still listed, delete refused), unbundle
  (sha256 round-trip, flag cleared), remove, delete → **112 checks**.
  Totals: 62+26+25+112 = 225. Live probe: full create → add → default-hide/toggle → filter → bundle →
  unbundle → remove → delete round-trip on real data.

## Selection mode + batch operations (webui restart75)

- **Select toggle** (`Select` button in the status row, `Escape` also exits): while active, clicking a
  card toggles its selection instead of opening the detail drawer (no more aiming for the 16 px
  checkbox), shift-click selects a range over the loaded order, "Select shown" grabs every loaded card
  (infinite scroll may have loaded more than one page), and the batch bar stays visible with a live
  "N selected" count (dimmed at 0).
- **Batch operations**: Endorse, Dislike, Archive, Unarchive, Stage, Unstage, Album… (add/remove),
  Copy to Censored, Trash, Clear. The selection is KEPT after each operation so ops can be chained; it
  is pruned only when cards are removed (trash/purge).
- **Copy to Censored** (`POST /gallery/api/copy-censored`): copies the selected originals into
  `<repo>/outputs/censored` for publishing (flat names; same-name files get `_1`, `_2`, … suffixes).
  Re-copying an unchanged image is reported as "already there" instead of duplicating it, bundled
  album originals are extracted from the album zip, and missing originals are reported per key.
  `GALLERY_CENSORED_DIR` overrides the target folder.
- **Stage semantics**: rated items (endorse/dislike) cannot be staged — the API now reports that as a
  per-key error (previously a silent no-op reported as success).
- **Engine-key alignment (bug fix)**: the desktop gallery + SD Lite key qwen/krea2 outputs as
  `<engine>-outputs-<engine>-<date>-<time>-<stem>`; the v2 indexer had stored a different variant and
  the action router derived a third, so legacy-facade actions (stage/archive/…) silently no-op'd for
  engine items. The indexer now maps the canonical key (plus the old form for back-compat), the API
  derives the same canonical key, and a one-time `engine_keys_backfilled` migration maps existing rows.
- Tests: `gallery_api_test.py` 108 (engine key alignment incl. stage/archive via canonical key; stage
  guard) — totals 62+26+25+108 = 221. Live probe: select mode on/off + drawer stays closed,
  "2 selected" and select-shown, staged badges appear on the selected cards then unstage clears them,
  shift-range (6), Escape exit — plus the full albums/views/groups/trash suite.

## Detail fullscreen split viewer

- Clicking the detail drawer preview opens the app-wide lightbox as before. On viewports
  with at least 520 px of room beside the drawer, the lightbox is constrained to that left
  stage (`gv2-lightbox-split`) and the drawer is raised above it (`gv2-detail-split`), so
  the image can be inspected fullscreen while metadata and actions stay visible and usable.
- Narrow viewports keep the classic full-screen lightbox. Resizing while the viewer is open
  switches modes live; Escape/close returns to the drawer, a second Escape closes the
  drawer, and prev/next navigation plus wheel zoom and drag panning work in both modes.
  Up/Down still endorse/dislike the open item instead of scrolling the page.

## Deferred by design (plan phases)

- **G3 soak** (1 week, dual-write keeps both stores fresh) — no action needed.
- **M6 retire** (`python -m modules.gallery_migrate m6 --confirm`): delete absorbed
  composer `.composerstate.json` files (DB copies verified first), quarantine dirs, and
  legacy cache webp dirs. Old gallery keeps working meanwhile (regenerates caches lazily).
- Old-tab UI is unchanged (still reads the legacy DB; thumbnails regenerate on demand
  after cache import). G4 (UI parity checklist) governs retiring the old tab.

## Verify / operate

```
# tests (all isolated temp DBs)
python tmp/gallery_v2_test.py            # core schema/tags/FTS/lifecycle   (62)
python tmp/gallery_migrate_test.py       # M0-M3 fixture                      (26)
python tmp/gallery_bridge_test.py        # dual-write mirrors                 (25)
python tmp/gallery_api_test.py           # HTTP API: blob ETag, groups/views/actions, albums, engine keys (112)

# migration
python -m modules.gallery_migrate m0|m1|m2|m3|gates|all
python -m modules.gallery_migrate m6 --confirm   # only after the soak

# live
restart the webui -> tab "Gallery v2"; API at /gallery/api/*
```

## Known constraints preserved

- New JS file → webui restart; stylesheet/JS served with `?mtime` stamps.
- Source files stay ASCII-only (emoji via escapes/entities).
- `tmp/` is gitignored — use `includeIgnoredFiles` when searching test files.
- No new pip dependencies (stdlib sqlite3/FTS5/zlib/PIL only).
- **Late options must carry a section**: `shared.opts.add_option("gallery_v2", shared.OptionInfo(default, label, section=("gallery-v2", "Gallery v2")))` — this fork's `options.reorder()` crashes on `section=None` (`item.section[1]`), which aborts startup right after model load with a silent exit(1).
