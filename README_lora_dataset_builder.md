# LoRA Dataset Builder (verified, kohya-ready)

`lora_dataset_builder.bat` + `gemini_workflow/lora_dataset_builder.py`.

This is the **replacement** for the `lora_data_maker` → hand-pick →
`caption_deepbooru` chain. It needs no manual selection pass and produces a
dataset that is actually sized for SDXL training.

```bat
.\lora_dataset_builder.bat --profile mika ^
    --face   .\data\collection\genshin\mika_avatar.png ^
    --outfit .\data\collection\genshin\_refs\mika\character_mika_game.png ^
    --out    .\data\train_data\genshin\mika
```

That writes `data\train_data\genshin\mika\3_lora_mika_v4\img_001.png + .txt`.
The images live in a `<repeat>_<name>` subfolder because sd-scripts reads the
repeat from that folder name, and the training bats require a subfolder — so
`--out` is exactly what you hand to training:

```bat
.\train_lora_sdxl_pro.bat .\data\train_data\genshin\mika mika_v4
```

`--keep_tokens=2` (the default of `train_lora_sdxl_pro.bat`) protects the two
leading caption tags.

## Why the old flow produced weak LoRAs

| problem | old flow | this builder |
|---|---|---|
| resolution | 3x4 contact sheet cut into **~580px tiles**, upscaled to a 1024 bucket (~1.8x) | **one image per call at 2K** (2048px), cover-cropped to an SDXL bucket (1024x1024 / 896x1152 / 832x1216) |
| shot coverage | face/portrait only | face, upper, cowboy **and** full body × front, three-quarter, side, back |
| background | pure white only → white gets baked in | white **and** gradient / library / Mondstadt plaza, and the caption always names the background |
| bad images | broken / wrong character / double faces / duplicates reached training, deleted by hand | local QA (blur, blank, bad-cut gutter, perceptual duplicates) **plus** a vision-model judge (right character, one person, ahoge, outfit, text) |
| captions | DeepDanbooru on AI output (`1girl` on a boy, wrong eye colour) → manual `clean_dataset_genshin.py` pass | generated from the shot plan + the judge's reading of the finished image; two leading tags are always `genshin impact, <character>` so `--keep_tokens=2` protects the trigger |
| review | open every tile | open `review.html` once — rejects are already excluded and labelled with the reason |

## The shot plan (22 calls)

One image per call, one explicit shot each:

```
face      01 front · 02 three-quarter · 03 side · 04 laugh · 05 serious · 06 surprised
upper     07 front · 08 three-quarter · 09 arms crossed · 10 from behind · 21 indoor
cowboy    11 front · 12 side walking
full      13 front · 14 three-quarter · 15 side · 16 back · 17 walking
          18 action · 19 sitting · 20 holding the book · 22 outdoor
```

`--shots face,full` restricts it; `--max-calls N` is a hard cap — the run
stops cleanly instead of overrunning your quota. 22 shots leave ~10 calls
for retries inside the default cap of 32.

Every shot carries a **framing hard rule** ("the picture is cropped at the
collarbone / waist / mid-thigh … legs and feet are OUTSIDE the picture") and
the matching negatives. Without it the model draws the whole figure for every
shot — the full-body OUTFIT reference pulls it that way — and a 22-shot plan
collapses into 22 full-body images.

## Verification, in order

1. **Local QA** — `tools/dataset_qa.py` runs on the root `.venv` (numpy + PIL,
   no model, no network): decode failure, short side below `--min-side`,
   Laplacian-variance blur floor, blank/near-empty canvas, a leftover white
   gutter from a bad grid cut (detected as a flat white band ending in a hard
   step, so a legitimately white background is *not* flagged), and dHash
   perceptual duplicates (the sharper copy wins).
2. **Judge** — the Gemini *text* model reviews candidates in batches of
   `--judge-batch` (default 4) together with the face reference and returns
   strict JSON: `character` match/weak/wrong, `people`, the `shot`/`view`/
   `background` it actually drew, `ahoge`, `outfit`, `anatomy`, `artifacts`.
   Text-model calls do **not** consume image-generation quota.
3. **Decision** — reject on wrong character, more than one person, broken
   anatomy, text/watermark/logo/border/multi-panel, wrong outfit, and (for
   face/upper shots) a missing ahoge. `--lenient` drops the ahoge/outfit
   warnings. Official references that turn out to be a 3D in-game render are
   used for generation but kept out of the dataset (`--no-include-refs` turns
   that off entirely).

The judge's reading also rewrites the caption: if a "front view" prompt
actually came back as a cowboy shot from behind, the caption says so.

## Captions

```
genshin impact, mika (genshin impact), 1boy, male focus, blonde hair, short
hair, ahoge, curly hair, colored tips, blue eyes, <outfit tags>, <shot>, <view>,
<expression>, <background tags>, solo
```

No `1girl`, no tagger noise, no identity tag missing on some images. The
identity/outfit block is constant so it binds to the trigger.

## Adding characters

Profiles live in `gemini_workflow/lora_dataset_builder.py` (built-in `mika`)
and can be overridden or extended in `config_states/lora_dataset_profiles.json`
— copy the `_example` block. Fields: `game`, `character`, `trigger`, `repeat`,
`dataset_group`, `gender`/`identity`/`outfit` (caption tags),
`identity_prompt`/`outfit_prompt` (generation wording), `must_keep`, `avoid`,
`require_ahoge`.

## Fetching official references

Real official art is the strongest identity anchor a character LoRA can get:

```bat
.\.venv\Scripts\python.exe .\tools\fetch_character_refs.py ^
    --page Mika --match "^File:Character Mika" ^
    --out .\data\collection\genshin\_refs\mika
```

Wiki image CDNs answer 403 without a `Referer`, which the tool sends
automatically; `--url` takes explicit URLs instead.

## Outputs

```
data/train_data/genshin/mika_v4/3_lora_mika_v4/   img_001.png + img_001.txt ...
outputs/lora_dataset_builder/<date>/<time>/
    shots/*.png     as generated (full size)
    candidates/     exactly what the QA + judge saw
    qa.json         every metric + reject reason
    run.json        prompts, verdicts, captions, call budget
    review.html     kept vs rejected contact sheet — the only thing to open
```

> `--out` is the dataset **root**; the `<repeat>_<name>` level below it is
> created automatically.

## Flags

| flag | meaning |
|---|---|
| `--profile NAME` | character profile (`mika` built in) |
| `--face IMG...` | identity reference(s) — required |
| `--outfit IMG...` | outfit reference(s), official art / in-game render |
| `--shots KINDS` | `all` or `face,upper,cowboy,full` |
| `--max-calls N` | hard cap on image calls (default 32) |
| `--size 1K|2K|4K` | generation size (default 2K) |
| `--retries N` | retries per shot on API errors (default 1) |
| `--no-judge` | local QA only |
| `--lenient` | ignore ahoge/outfit/style warnings |
| `--no-include-refs` | keep reference images out of the dataset |
| `--min-side` / `--blur-threshold` | local QA thresholds |
| `--resume` | reuse `shots/*.png` already in the run folder |
| `--dry-run` | print the plan, prompts and captions — no API calls |
| `--selftest` | offline test of plan, captions, decisions and QA |
