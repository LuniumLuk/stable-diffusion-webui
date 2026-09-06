# LoRA Data Preparation Pipeline (merged)

One python script + one bat entry that takes your character's avatar picture
and a few fullbody outfit pictures, and produces a collected, captioned,
kohya-ready training set of **~20 images per outfit**.

```
image_maker.bat                    <- single entry (this file)
gemini_workflow/image_maker.py     <- the whole pipeline
tmp/lora_face.txt                  <- refined face sheet prompt   (GRID: 3x2 -> 6 images)
tmp/lora_upper.txt                 <- refined upper-body prompt   (GRID: 2x3 -> 6 images)
tmp/lora_fullbody.txt              <- refined fullbody prompt     (GRID: 2x4 -> 8 images)
training_data/lora_<name>/         <- RESULT folder (images + .txt captions + manifest.json)
```

## Pipeline stages

1. **Plan** — resolve the face / upper / fullbody stage prompts and their grids.
2. **Refine** — curated sheet prompts with a machine-readable `GRID:` header and
   per-panel `R{r}C{c}: tags :: description` caption lines; `{outfit}` /
   `{trigger}` placeholders are filled from `--outfit-desc` / `--trigger`.
3. **Generate** — one sheet image per prompt per variation on the Gemini
   "Nano Banana" image model, with your reference images attached (identity
   and outfit come from the refs).
4. **Split** — slice each sheet into its grid cells, trimming `--grid-padding`
   pixels from every border to remove grid-line artifacts.
5. **Caption** — write a kohya-style `.txt` tag file for every training image
   (trigger + panel tags + outfit tags).
6. **Collect** — copy everything into `training_data/lora_<trigger>[_<outfit>]/`
   (flat images + captions, `sheets/` originals, `refs/` if `--include-refs`,
   `manifest.json`).

## Quick start

Prepare in `tmp/`:
- one avatar picture, e.g. `tmp/img_chara_rana.png`
- a few fullbody pictures with different outfits, e.g. `tmp/body_rana.png`

Then the merged one-command run for ONE outfit:

```bat
.\image_maker.bat --mode all ^
  --avatar .\tmp\img_chara_rana.png ^
  --ref-images .\tmp\body_rana.png ^
  --outfit casual ^
  --outfit-desc "blue sailor uniform, white thighhighs"
```

Default counts (`--variations 1`):

| stage    | grid | images |
|----------|------|--------|
| face     | 3x2  | 6      |
| upper    | 2x3  | 6      |
| fullbody | 2x4  | 8      |
| **total**|      | **20** |

Repeat per outfit (change `--ref-images` / `--outfit` / `--outfit-desc`); each
outfit lands in its own `training_data/lora_rana_<outfit>/` folder.

Preview the plan without spending API calls:

```bat
.\image_maker.bat --mode all --avatar .\tmp\img_chara_rana.png ^
  --ref-images .\tmp\body_rana.png --outfit casual --dry-run
```

Offline machinery check (grid split + prompt parsing, no API, no key):

```bat
.\image_maker.bat --selftest
```

## Legacy per-stage commands (still work, now auto-collected)

Your original command style is fully supported. **Splitting is opt-in:** a
variation is kept as ONE full image unless `--grid COLS ROWS` is passed —
the prompt text is never auto-interpreted as a grid, so e.g.
`--prompt-file prompt.txt --ref-images ref.png --variations 3` produces 3
single images (one per variation):

```bat
.\image_maker.bat --prompt-file .\tmp\lora_face.txt ^
  --ref-images .\tmp\images.jpg .\tmp\img_chara_rana.png ^
  --variations 1 --grid 3 2 --grid-padding 8 ^
  --image-size 2K --aspect-ratio 1:1

.\image_maker.bat --prompt-file .\tmp\lora_upper.txt ^
  --ref-images .\tmp\img_chara_rana.png .\tmp\body_rana.png ^
  --image-size 2K

.\image_maker.bat --prompt-file .\tmp\lora_fullbody.txt ^
  --ref-images .\tmp\img_chara_rana.png .\tmp\body_rana.png ^
  --image-size 2K
```

All three runs collect into the same `training_data/lora_rana/` folder
(trigger `rana` is inferred from `img_chara_rana.png`).

> The pipeline never guesses a grid from prompt text. Pass `--grid COLS ROWS`
> explicitly to split (e.g. the face sheet run above), and the pipeline warns
> whenever `--grid` disagrees with a `GRID:` header written in the prompt.

## Flags

| flag | default | meaning |
|------|---------|---------|
| `--mode face\|upper\|fullbody\|all` | inferred | stage(s) to run |
| `--prompt-file PATH` | - | single-stage sheet prompt (used verbatim) |
| `--face/upper/fullbody-prompt-file` | `tmp/lora_<stage>.txt` | all-mode overrides |
| `--avatar PATH` (repeatable) | - | identity picture, attached to every stage |
| `--ref-images ...` | - | outfit fullbody pictures (face mode: face refs) |
| `--variations N` | 1 | sheets per stage (images = N x cols x rows) |
| `--parallel` | off | generate the stage's variations concurrently |
| `--parallel-workers N` | min(variations, 8) | max concurrent variation jobs |
| `--parallel-delay S` | 1.0 | seconds between launching each parallel job |
| `--grid COLS ROWS` | none (no split) | split each image into a COLS x ROWS grid (single mode only) |
| `--grid-padding P` | 8 | trim P px from each cell border |
| `--image-size 1K\|2K\|4K` | 2K | Gemini output size |
| `--aspect-ratio W:H` | per stage | 1:1 face / 3:2 upper / 16:9 fullbody |
| `--outfit NAME` | - | result folder suffix + dataset grouping |
| `--outfit-desc "tags"` | - | outfit description for prompts and captions |
| `--trigger WORD` | from ref filename | LoRA trigger word in captions |
| `--quality-tags "..."` | none | caption tags prepended to every caption |
| `--caption-style tags\|none` | tags | write `.txt` tag files per image |
| `--include-refs` | off | copy avatar/outfit refs into the dataset |
| `--training-dir DIR` | `training_data` | base result folder |
| `--no-collect` | off | keep only raw outputs |
| `--dry-run` | - | print plan, no API calls |
| `--selftest` | - | offline machinery check |
| `--retries N` / `--image-model` / `--api-key` / `--output-dir` | legacy | API behavior |

## Result folder layout

```
training_data/lora_rana_casual/
  face_001.png      face_001.txt     <- "rana, 1girl, solo, portrait, front view, neutral expression"
  face_002.png      face_002.txt
  ...
  upper_001.png     upper_001.txt
  fullbody_001.png  fullbody_001.txt
  sheets/                            <- original generated sheets
  refs/                              <- only with --include-refs
  manifest.json                      <- settings, grids, per-image captions
```

## Captions

Every tile gets a tag file built from the panel's own `R{r}C{c}` line, so
face tiles are captioned with their expression, fullbody tiles with their
angle/pose, plus the trigger word and outfit tags. Feed the folder straight
into kohya / sd-scripts (use the trigger word for tagging there).

## Tips

- Use `gemini-3.1-flash-image` (Nano Banana 2) for 2K sheets; edit
  `config_states/gemini_models.txt` to change the default model.
- If a sheet comes back with the wrong panel count or layout, re-run with
  `--variations 2` and keep the good one — or raise `--retries`.
- `--grid-padding 8` trims white gutters; raise it to 12-16 if the model
  draws thick grid lines between panels.
- Add `--include-refs` to include the original avatar/outfit pictures in the
  dataset (helps the LoRA lock the identity and outfit).
- Captions default to no quality tags; add `--quality-tags "masterpiece, best quality"`
  if your base model expects them.
