# LoRA Data Maker (no prompt files)

`lora_data_maker.bat` + `gemini_workflow/lora_data_maker.py`. Prompts are
curated and built in — the only inputs are your pictures.

## Usage

```bat
.\lora_data_maker.bat --avatar .\tmp\img_chara_rana.png ^
  --fullbody .\tmp\body_rana.png .\tmp\outfit_b.png .\tmp\outfit_c.png
```

| input | what it makes |
|-------|---------------|
| avatar A alone | one 3x4 face grid -> **12 different expression images** |
| A + fullbody B | one 3x4 upper grid (12) + one 3x4 fullbody grid (12) = **24 images** |
| A + fullbody C, A + fullbody D, ... | same per outfit picture |

With 3 fullbody pictures: 12 + 3 x 24 = **84 images** in one run, 7 API calls.

## Variety (no two sheets are prompted alike)

Each generated sheet samples from built-in pools, so every outfit (and every
`--variations` repeat) gets a different prompt:

| element | pool |
|---------|------|
| art style (**per panel**, 12 distinct per sheet) | anime screencap / anime movie / retro 90s anime / light novel / watercolor / vibrant flat / **detailed hatching** / **plain flat colors** / **vibrant saturated colors** / **monochrome grayscale** / pastel / cute simplified / shoujo manga / shonen action / Makoto Shinkai / Akira Toriyama / Naoko Takeuchi / Yoshitaka Amano / Vanripper / Kantoku |
| scene / background (**per panel**, when enabled) | sunny park / city street / cozy cafe / school classroom / cherry blossom road / rainy street / winter snow / traditional Japanese room / ... (18 scenes) |
| lighting (random per sheet) | soft studio / gentle diffused / bright even / soft top-down |
| panels (12 sampled from 18, random order) | face: 18 expressions; upper & fullbody: 18 poses each |

## YAML config

`config_states/lora_data_maker.yaml` (created automatically on the first run,
or point anywhere with `--config PATH`) controls everything random about
styles and scenes:

```yaml
randomize_panel_style: true    # true  -> each panel gets its own random style
                               # false -> one uniform style (first list entry)
styles:                        # the FULL art-style list (tag + text)
  - tag: detailed hatching
    text: "detailed ink hatching style, fine cross-hatched pen shading, bold outlines"
  ...

randomize_panel_scene: false   # true  -> each panel gets its own random scene
                               # false -> panels stay on the plain white sheet
scenes:                        # the FULL background-scene list (tag + text)
  - tag: cozy cafe interior
    text: "background: a cozy cafe interior with wooden tables and warm tones"
  ...
```

- Both toggles can be on at once: every panel then carries its own art style
  *and* its own background scene (`Panel art style: ... Background scene: ...`).
- `--style TAG` on the command line always wins over `randomize_panel_style`.
- `--seed N` makes a run reproducible; PyYAML is preferred, but a built-in
  YAML-subset loader keeps the file format working if it is not installed.

- Each panel of a sheet declares its own art style inside its description
  ("Panel art style: ..."), so one image already yields 12 style variants of
  the same character/outfit — while the sheet-framing wording stays in the
  concise mode that keeps the grid layout accurate.
- `--style TAG` pins one art style for all 12 panels (e.g.
  `--style "monochrome grayscale"`).
- `--seed N` makes the whole run reproducible (same style/lighting/panel draws).
- If a sheet fails (for example an artist style is refused), the pipeline
  resamples styles/panels and retries automatically.
- With `--captions`, each caption carries its panel's style tag
  (`rana, 1girl, solo, upper body, front view, arms crossed, detailed hatching`),
  so training can separate character from style.
- The artist-style entries can occasionally be blocked by the image model;
  remove any line from `STYLES` in `gemini_workflow/lora_data_maker.py` if
  one keeps failing.

## Grid compliance

The sheet-framing wording stays in the concise mode that produced the most
accurate grids: "clean 3-column by 4-row matrix of 12 separate square panels
... wide uniform white gutters", one panel line per cell (`R{r}C{c}`), and
light negative reminders (no merged / missing / extra panels, no uneven
rows, no crooked grid). Art-style variety is expressed compactly inside each
panel line ("Panel art style: ...") so it does not bloat the framing text.
If a sheet still comes back misaligned occasionally, re-roll it
(`--variations 2`) and keep the good sheet, or raise `--grid-padding`.

## Output

```
training_data/lora_<trigger>/     <- trigger inferred from img_chara_<name>.png
  <trigger>_face_001.png ... <trigger>_face_012.png      (12 expressions)
  <trigger>_o01_upper_001.png ... <trigger>_o01_upper_012.png   (outfit 1)
  <trigger>_o01_fullbody_001.png ... <trigger>_o01_fullbody_012.png
  <trigger>_o02_upper_001.png ...                             (outfit 2)
  <trigger>_o02_fullbody_001.png ...
  ...
```

Every output image is named with the trigger as prefix (e.g.
`rana_face_001.png`, `rana_o01_upper_007.png`), so files from different
characters never collide even if you merge dataset folders. Just a flat
folder of images. Add `--captions` to also write kohya-style
`.txt` tag files beside each image (trigger + 1girl + solo + panel tags).
Raw sheets/tiles/manifest stay in `outputs/lora_data_maker/<timestamp>/`.

## Flags

| flag | default | meaning |
|------|---------|---------|
| `--avatar A [A2 ...]` | required | avatar picture(s) = identity refs |
| `--fullbody B C D ...` | none | outfit pictures; each adds upper + fullbody sets |
| `--out DIR` | `training_data/lora_<trigger>/` | result folder |
| `--variations N` | 1 | sheets per stage (each sheet = 12 images) |
| `--style TAG` | per config | pin one art style for all 12 panels (see YAML config) |
| `--config PATH` | `config_states/lora_data_maker.yaml` | YAML config file |
| `--seed N` | random | reproducible style/lighting/panel sampling |
| `--grid-padding P` | 8 | trim P px from each cell border |
| `--image-size 1K\|2K\|4K` | 2K | Gemini output size |
| `--aspect-ratio W:H` | 3:4 | matches the 3-column x 4-row sheets |
| `--captions` | off | write `.txt` tag files beside images |
| `--trigger WORD` | inferred | folder name + captions |
| `--dry-run` | - | print plan only, no API calls |
| `--selftest` | - | offline split/parse check |
| `--retries N` / `--image-model` / `--api-key` / `--output-dir` | legacy | API behavior |

## Tips

- Run `--dry-run` first to see the exact plan, sampled styles and counts.
- `--selftest` verifies the split/caption/prompt-assembly machinery without the API.
- The built-in face pool covers 18 expressions, upper/fullbody pools 18 poses
  each; every sheet samples 12 of them in random order.
- The older prompt-file pipeline still lives at `image_maker.bat`.
