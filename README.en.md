# SteinsGateLabStage

Run *STEINS;GATE* character E-mote models in the browser, with arm-pose switching, touch reactions, voice playback and lip sync.

> **Unofficial, non-commercial fan project. Not affiliated with MAGES., Nitroplus, or M2 Co., Ltd.**
> This repository contains **no** original game assets (models, artwork, backgrounds, voice) and **no** E-mote runtime (proprietary SDK).

[中文](README.md)

---

## Contents

The homepage `index.html` has three in-page tabs ("Works / Characters / Tech") plus two mode entries in the top nav: Story Mode and LAB:

| Entry | Description |
|---|---|
| `index.html` | Character archive page (world intro + Labmem roster), pure static |
| `steins_gate/story/index.html` | **Story Mode**: visually edit lines and play them back — typewriter with click / auto advance |
| `steins_gate/stage/index.html` | **LAB player**: interactive E-mote models (touch reactions, arm poses, lip sync). Both modes need the files under "Quick start" below |

## Features

- **Direct PSB reading** — parses `.pure.psb` (PSB v4) binaries directly. No decompilation, no pre-generated config, no build step. Models dropped into `character/data/<character>/` appear in the character tab automatically; touch reactions are configured per model in the [action config guide](docs/动作配置指南.md).
- **Arm-pose switching** — handles PSB 4.0 mutually exclusive append-parts (`insert` / `delete`) by patching the GPU texture upload, erasing the unused arm set. Works with an SDK runtime that only supports 3.9.8.
- **Touch reactions** — hit areas derived from `charaProfile` labels (eye / mouth / bust / top …), each resolving to a random action from a pool, optionally with audio and variable interpolation.
- **Lip sync** — offline WebAudio envelope analysis driving `face_talk` via rAF lookup. No fallback playback path; audio failures are reported and skipped.
- **Scene UI** — character tabs with a model panel, a background preview panel, and tab reordering. Order is written back to `character/actions_config/order.json`; backgrounds and cards read the 720p thumbnails in `static/background/.thumbs/`.
- **Story Mode** — `/steins_gate/story/` is a single page with two modes: a visual scene editor (drag / ▲▼ / add-remove lines) and a typewriter player (click / auto advance / voice / action macros). Character bindings live in `steins_gate/story/cast.json`, scenes in `steins_gate/story/scenes/*.json`. It supports **multiple characters on stage**: a scene's `stage` array lists who appears and where (`x` -1..1, `scale`, `z`), each line's `role` picks the speaker (whose action / voice / lip-sync follow him), and other on-stage roles get their own `cues` entries on that line (separate players, no cut-offs). A line's `enter` / `exit` brings characters on or off mid-scene, and `move` changes blocking within the same scene (omit it to inherit the previous line). Omitting `stage` auto-spreads the roles seen in the lines, so older scripts keep working. The player's "Live line" panel lets you type text + pick audio (a local file or one from the `character/sounds/` audio list) or synthesize it, and make the selected on-stage character speak without a script.
- **Dev panel** — built-in inspector for selectors, poses and variables (`installDevPanel`). The "③ Variable tuning" section has a "Copy params" button that exports the current slider values as a `variables` array JSON (`[{name,value,duration}, ...]`), **skipping any item with `value=0`** (0 is the reset state and meaningless in an action); it says "no nonzero values" when everything is 0. Sliders now span each variable's real `minValue / maxValue` (`face_eye_open_l` is `-10 ~ 55`, not a hardcoded 0~100). The "④ Variable frame aliases" section lays out the official `variableList[].frameList`: variables are grouped by range and every frame name becomes a button (e.g. `閉じ 10`) that sets the value directly, with the current frame highlighted; the search box filters by frame name (typing `閉じ` keeps only the variables that define it and expands them). These aliases always existed inside the models — there was simply no UI for them before.

### Multiple characters on stage (Story Mode)

A scene can keep several characters on screen at once. Bind each role to a model in `cast.json`, then declare who appears and where with `stage`:

```json
{
  "title": "Two-person dialogue",
  "background": "background.jpg",
  "bgm": [
    { "file": "theme.mp3", "range": [1, 4] },
    { "file": "climax.mp3", "range": [5, 12] }
  ],
  "stage": [
    { "role": "Kurisu", "x": -0.35, "scale": 1, "z": 0 },
    { "role": "Suzuha", "x":  0.38, "scale": 1, "z": 1 }
  ],
  "lines": [
    { "role": "Kurisu", "text": "You're here.", "action": "calm", "exit": ["Suzuha"] },
    { "role": "Suzuha", "text": "Sorry I'm late!", "enter": ["Suzuha"] },
    { "role": "Suzuha", "text": "Don't stand in the doorway, come in.", "action": "smile",
      "cues": { "Kurisu": { "action": "surprised" } } },
    { "role": "Suzuha", "text": "I'll stand over here.", "move": { "Suzuha": -0.1 } },
    { "role": "Suzuha", "text": "I'll go now.", "exit": ["Suzuha"] }
  ]
}
```

- `bgm`: **background music** (optional, multiple segments). `file` is an audio file under `static/bgm/`; `range: [from, to]` is the 1-based inclusive line range (e.g. `[1,3]` covers lines 1–3). The track loops within its range without restarting when advancing lines; it only switches/stops on entering another segment or leaving all ranges. Legacy `{ file, from, to }` entries are migrated to `range` on load. The editor lists `static/bgm/` audio in the properties panel (filter it with the search box) — drag one onto the BGM track at the right of the script lines to place a segment. Drag the whole segment to move it, or its top/bottom grips to resize; both snap to whole lines. The track is narrow, so segment names are written vertically with the range in small digits at the bottom. Click a segment to reveal the right-side panel where you set the range, delete it, or hit Play for a preview; `Backspace`/`Delete` also removes the selected segment (editing never auto-plays; playback mode still follows lines automatically). A segment may set `fadeIn`/`fadeOut` booleans (default false): `fadeIn` ramps volume up at start, `fadeOut` ramps it down on stop/segment switch, both about 1 second, toggled by the "淡入"/"淡出" buttons in the right panel; they apply to both preview and playback.
- `stage`: `x` is a fraction of canvas width (-1 left / +1 right), `scale` a relative size, `z` the stacking order. This is the scene's **default blocking**. A role with any `enter` is treated as entering mid-scene and starts hidden; other roles start on stage. Who enters/exits at which line is decided by that line's `enter`/`exit`.
- `move`: **this line's blocking change**. Keys are role names, values are an `x` number or `{ x, scale, z }` (only the fields you want to change). Omit it and the previous line's position stays; once set it holds until the next change — no need to repeat positions on every line.
- `name`: **the name shown in the textbox from this line on**. Like `move`, it is sticky — it holds for that role until its next override, and omitting it inherits the previous line. Use it for unknown speakers ("???"): `role` still uses the cast key, so models, voices, blocking and actions are untouched:

  ```json
  { "role": "Kurisu", "text": "Who are you? How do you know my name?", "name": "???" },
  { "role": "Kurisu", "text": "Don't look at me like that." },
  { "role": "Kurisu", "text": "...Fine. I'm Makise Kurisu.", "name": "Kurisu" }
  ```

  The default lives in `cast.json`: `{ "Kurisu": { "model": "...", "name": "Assistant" } }`; without it the key is used. The key is the internal id (script references, voice folder, model binding all hang off it) — the display name only changes the text on screen, so nothing breaks. Two layers in the editor: the "Display name" of the selected line applies **from that line on** (empty = inherit, `⟲` fills in the role's real name for a reveal, the adjacent "set as default" turns it into the role default); the "Display name" on the cast tab is the **global default**.
- Each line's `role` picks the speaker: `action` comes from `cast[role].actions`, `voice` from `cast[role].voiceDir`.
- `cues`: **per-character performance for the same line** — other on-stage roles can each get their own `action` / `voice` (both optional):

  ```json
  "cues": {
    "Kurisu": { "action": "surprised", "voice": "resg00_01_krs0005.xwma.opus" },
    "Suzuha": { "action": { "timeline": "表情_笑う", "diffSlot1": "ひく", "diffSlot2": "" } }
  }
  ```

  An action object has exactly three fields: `timeline` (main timeline) and `diffSlot1` / `diffSlot2` (two independent diff slots). Omit a field to leave it alone; an empty string clears it explicitly (say the previous line had a `diffSlot2` and this one must drop it).

  Every role gets its own audio player, so lip-sync and playback stay on that character and two people can talk at once without cutting each other off.
- Auto-advance is not a line property: the `AUTO` button on the dialogue box (native `main.psb.m` slices, placed where the game puts it — bottom-left, `left:26 / top:1022`) is a global toggle. When lit, each line waits for the speaker's voice (plus that line's `wait`) and then advances; clicking the screen still advances immediately. The toggle is remembered in localStorage. The legacy per-line `auto` field is ignored on read and stripped on save.
- The right panel is organised one section per line: `Scene` → `Line N`. The line number appears once — speaker, display name, text, AUTO pause and this line's **cast on stage** all live in that single "Line N" block ("Cast on stage" is an inline sub-heading, no longer a section of its own). `cast.json` no longer takes a slot in the right panel.
- "Cast on stage" shows one card per role, four rows that cover everything that role does on this line:
  1. role dropdown (who is in the scene) + keep / enter / exit (this line's `enter`/`exit`) + remove;
  2. position and scale — **line 1 is the scene default** (stored in `stage`), editing from line 2 onwards writes that line's `move`, otherwise it inherits (grey = inherited, orange = overridden, `↺` drops back);
  3. this line's action and voice — the speaker writes line-level `action`/`voice`, other roles write `cues`; picking "custom…" expands **main timeline / diff slot 1 / diff slot 2** as three dropdowns, and typing a name + "save as macro" writes it into `cast[role].actions`;
  4. **binding**, collapsed to one summary line (`Binding  Kurisu_white ▸`): open it for the model dropdown and the voice folder — "which skin, where the audio lives" belongs to the role itself.
  All three dropdowns are filled from that role's model, so you can re-pick at any time without clearing first; empty means "leave as is" (an empty diff slot explicitly clears it).
  There are no separate "Blocking" or "Performance" blocks any more: where a role stands, what it does and which model it wears all live in its own card.
- Display names surface everywhere in the editor: the line list, the speaker dropdown and the role-card dropdown all show the `cast` display name (with `(internal id)` appended when it differs, so duplicates stay distinguishable), and the "Display name" field's `inherit: X` hint updates as you type.
- Next to "Display name" there is `⟲` (fill in the role's real name, for a reveal) and "set as default": the latter writes the current value as that role's **default name** into `cast[role].name`. You never leave the line to name a character.
- The left column has two **tabs**, `Script` / `Cast`, sharing the same area; `Esc` goes back to the script. The cast tab gives its space to the `roles / action macros / properties` three-column view (the right panel steps aside) for auditing, renaming and deleting; each macro row shows its main timeline inline, so you don't have to open them one by one. Everyday edits (model, default name, macros) still happen where they are used — on the role card, the line's "set as default", "save as macro" — so there is no need to visit this tab.
- There is exactly **one "Save"**: scene and `cast.json` are written together (`saveCurrent` PUTs both files). The cast tab has no save button of its own.
- **Variables from stage into script**: after tuning a set of values in the LAB page's "Variable tuning", click "Copy params" (exports nonzero `variables` JSON), then in the cast tab select an action macro → "variables" fields → "Paste import", and paste the JSON to bulk-add variable rows (or edit rows directly: the variable name is a dropdown filled from the current model's `variableList`; names from old configs or pasted imports that the model does not declare still appear as an option; pick "custom…" to type a brand-new name, then press Enter or click away to switch back to the dropdown automatically, Esc to cancel; value/duration/delay remain numeric inputs; Ctrl+Enter imports quickly). This lets an action macro carry the tuned diff/expression variables.
- **Blinking (`blink`)**: the rhythm is not ours — it follows the wasm's built-in auto-blink, which every 1.3–3 s drives `face_eye_open` up to `10` (閉じ) along a 10-frame curve and back to its baseline. **The variable set is detected per model**: `face_eye_open_l` / `_r` are the actual eyelids (`0` open / `5` half / `10` closed / `55` special), while the SDK only drives the singular `face_eye_open` (inner eye shadow / pupil line / highlight), so the L/R eyelids have to be filled in by us; models that do not declare them only expose `face_eye_open` and we write nothing — the SDK already moves those eyelids, and writing would double the closure. Driving uses `setVariableDiff` (module `blink`): **the diff is added on top of the current base and does reach the renderer** (measured: lid `0` + diff `15` renders identically to lid `10`), so a running action fade or a manual dev-panel tweak needs no special casing, and writing the diff back to `0` simply reveals the base again. Each frame does one linear follow: `k = (track - trBase) / (10 - trBase)`, `diff = (closeValue - current lid value) * k`. Two details matter: **① relative baseline** — the resting value of `face_eye_open` is raised by expressions (鈴羽 angry = `2`, 紅莉栖 surprised = `8`), so using the absolute value as a ratio leaves the eyes permanently half-closed and gives a blink only 2 units of travel (it reads as "barely blinking"); the baseline is identified by **rate of change**: a shift slower than `0.015` units/ms counts as an expression fade (surprised: 8 units over 1 s = `0.008`) and is followed directly, while for 250 ms after any fast change (a blink is `0.02~0.12`) drift is ignored so a brief pause at the blink peak is not mistaken for a new baseline (which would read as \"open once, then close\"). This is frame-rate independent, so low frame rates do not cause misjudgement. **② close the gap to `closeValue` instead of adding `closeValue`** — the lid base is not 0 (surprised `-5`, angry `4`), and a plain `+closeValue` either under-closes or overshoots (`4+10=14` is already out of range). Separately, if `track` sits at full closure for more than 250 ms it is not a blink but an action holding the eyes down (鈴羽's 困る01 head-shake pins `face_eye_open` at `10`); the baseline is re-learnt and the diff zeroed instead of forcing the eyes shut — otherwise she stays closed for the rest of the scene, replay included. A diff has no remove API, so stopping the watcher / changing the eyelid variables / disabling blinking / switching action must all write `0` explicitly. Blinking starts for **every character** once staging settles, not when someone speaks. Configuration is per character: `blink` in `cast.json` (`on` defaults to `true`, `closeValue` to `10`; `vars` / `track` may point at other names), edited by the "<character> 默认眨眼" bar at the top of the cast tab; **actions no longer override it** — every action follows the character setting. Paging, switching scenes, the ending and entering edit mode all stop the watcher and zero the diff.
- Switching to a scene that needs new models reloads the page once; changing a model in a role card says so explicitly ("takes effect after saving and reloading").
- `stage` is optional: when absent, the roles seen in the lines are spread evenly, so existing scripts need no changes. See `steins_gate/story/scenes/demo.json` for a full example.

## Quick start

**This repository does not run out of the box.** Two categories of files are required and both are excluded by `.gitignore`:

1. **E-mote runtime** → `driver/`
   - Required: `emotedriver.js`, `emotedriver.wasm` (verified against the `driver_wasm_modularize` build), `emoteplayer.js`
   - Obtain from [M2 Co., Ltd.](https://emote.mtwo.co.jp/) via an SDK application
   - ⚠️ Proprietary software whose terms prohibit redistribution. **Never commit `driver/` to a public repository**; this project will not provide it.

2. **Models and assets** → `character/data/` and `static/background/`
   - `character/data/<character>/<name>.pure.psb.zip`, each containing one `pure.psb`
   - `static/background/` — background images, just drop the files in; `static/background/.thumbs/` is generated by the page
   - `static/bgm/` — background music audio, just drop the files in; drag one from the "Background Music" list in the story editor onto the BGM track at the right of the script lines, then click the segment to preview/configure it in the right-side panel
   - Must be extracted from a copy of the game you legally own. Not provided here.

Then serve over HTTP (`fetch` requires it; `file://` will not work):

```bash
node main.mjs --port 8000     # or ./run.sh 8000 (macOS / Linux / Git Bash)
                              # on Windows, double-click run.bat instead
# open http://127.0.0.1:8000/
```

Once running, the homepage offers three in-page anchors (Works / Characters / Tech) and two mode entries: the LAB interactive player and Story Mode. For story voice, drop audio into `character/sounds/` (missing files are silently skipped).

`main.mjs` is a dependency-free static server (Node 18+, default port 8899; `run.bat` / `run.sh` default to 8000, bound to 127.0.0.1 only). Beyond `python -m http.server` it adds these endpoints:

| Endpoint | Purpose |
|---|---|
| `GET/PUT /api/order` | Read/write character order in `character/actions_config/order.json` |
| `GET /api/thumbs`, `PUT /api/thumb` | Background thumbnails in `static/background/.thumbs/` |
| `GET/PUT /api/story` | Read/write `steins_gate/story/cast.json` and `steins_gate/story/scenes/*.json` |
| `GET /api/voice` | List live-line audio (`steins_gate/story/voices/`) |
| `GET /api/voice?name=…` | Stream audio with Range support (seekable) |
| `POST /api/voice` (octet-stream) | Import audio to disk, 12MB max (the page's "Pick audio" / "Audio list" never use this — no disk writes) |
| `POST /api/voice` (json) | Text → speech synthesis (TTS hook, `{"text":"…"}`) |

**Live-line audio source**: three tabs. "Pick audio" plays a local file in-browser via a temporary blob URL — never uploaded or written to disk. "Audio list" lists folders and audio files under `character/sounds/` and plays the chosen one from a static path — also never written to disk. "Text synthesis" is a TTS hook: set env vars `EMOTE_TTS_BIN` (e.g. `edge-tts`) and optionally `EMOTE_TTS_VOICE` (default `zh-CN-XiaoxiaoNeural`) to enable it; without config the endpoint returns 501 and the UI tells you to pick audio instead. Only synthesized audio is saved to `steins_gate/story/voices/`. The external command must accept `--voice <name> --text <text> --write-media <file>`.

Any other static server works too — write capabilities just degrade to read-only: ordering lasts for the session, thumbnails are only read from disk, scenes cannot be saved, and text synthesis (TTS) is unavailable; "Pick audio" and "Audio list" need no server-side writes and still work.

## Layout

```
index.html                  Character archive page
main.mjs                    Local server: static hosting + order / thumbnail / scene writes (no deps)
run.bat                     Windows launcher (node main.mjs --port 8000 --open)
run.sh                      macOS / Linux launcher (./run.sh [port], default 8000)
character/                  Character resources
  data/                     Models (not in repo), <character>/<model> two levels
  sounds/                   Voice clips (not in repo)
  actions_config/           Action configs (mirrors the data/ layout)
    common.json             Shared base, used when a model has no own config
    <char>/<model>.json     Per-model performance; basename matches the model, optional
    order.json              Character tab order, rewritten on reorder
common/                     Runtime shared by the player and story pages
  emote_core.js             Core: SDK bootstrap, animation loop, responsive layout (createLayout)
  action_config.js          Loads config by model name, sparse extends, inventory reconcile
  model_loader.js           PSB v4 parser + exclusive-parts config + loader
  gl_arm_pose.js            Texture-level arm erase (hooks texImage2D / texSubImage2D)
  lipsync.js                Lip sync (offline WebAudio analysis, rAF lookup)
  emote_config.js           Base model / action config
  config_validator.js       Config shape validation (with CLI self-test)
steins_gate/                     Page container
  stage/                    LAB player
    index.html              Player entry
    main.js                 Bootstrap, interaction, arm switcher, dev panel
    scene_ui.js             Control bar, model / sort / background panels
  story/                    Story mode: visual editor + player
    index.html              Story entry (single page, two modes)
    story.js                Scene I/O, typewriter player, line editor
    cast.json               Character -> model / voice dir / action macros
    scenes/                 Scene JSON files
    voices/                 TTS-synthesized audio ("pick audio" / "audio list" never write here; only text synthesis does)
static/                     Static assets
  css/  js/                 Stylesheets and scripts
  background/               Background images (not in repo)
    .thumbs/                720p thumbnails, generated by the page
driver/                     E-mote runtime (not in repo)
libs/fflate.js              zip inflate (third-party)
docs/                       Technical write-ups
```

## Technical notes

### Why parse PSB ourselves

Across the 83 `EmotePlayer_*` / `EmoteDevice_*` functions exported by the wasm, the 69 that `emoteplayer.js` actually calls expose only `charaProfile` labels and `charaBounds` — **not atlas rectangles, the `source` table, or `customSelectorList`**. Exclusive arm sets are therefore not enumerable at the SDK level and must be read from the raw bytes. That is the sole reason `PsbReader` exists.

The parser reads only the structure region (~1 MB) and skips the following ~200 MB of texture data, taking roughly 10 ms in-browser.

### Why patch at the texture layer

The runtime wasm is 3.9.8 and does not understand PSB 4.0 `insert` / `delete` semantics, so it draws both arm sets. Instead of modifying the SDK, the unused arm rectangles are erased to transparent while the atlas is uploaded through `texImage2D`.

### Further reading

| Document | For | Covers |
|---|---|---|
| [动作配置指南 — action config guide](docs/动作配置指南.md) | Anyone customizing reactions | Mirror-directory naming, field reference, sparse inheritance, inventory reconcile, CLI validation, troubleshooting |
| [技术路线 — technical route](docs/手臂姿势修复技术路线.md) | Anyone reusing this approach | Root cause, the four grouping criteria, PSB v4 decoding rules, texture-patch details, verification, evolution history |
| [实现说明 — usage guide](docs/手臂姿势切换实现说明.md) | Anyone modifying this code | Selector API, compat layer and timeline bridge, dev panel, swapping models, caveats |

All three are in Chinese; the code and the tables above should be enough to follow along.

## Known limitations

- Only unencrypted, uncompressed PSB v4 `pure.psb`. MDF / PSZ wrappers, PSB v3, or other platform exports need extra header and wrapper handling.
- Depends on the 3.9.8 runtime; future SDK changes may invalidate the texture-patch assumptions.
- Hit areas rely on the model's own `charaProfile`; models without it degrade to no reactions.
- Thumbnails are keyed by the source file name (`static/background/.thumbs/<stem>.jpg`). Replacing an image with a new file of the same name does not invalidate the old thumbnail; delete that file to regenerate it.

## Credits

- **[NekoWebShow](https://github.com/Chocola-X/NekoWebShow)** (AGPL-3.0) — origin of this project. The costume-name translation table and the WebAudio playback skeleton follow upstream's design approach; the bulk of the implementation — model loading, PSB parsing, the arm patch, scene UI, action configs and lip sync — was written separately.
- **[FreeMote](https://github.com/UlyssesWu/FreeMote)** (**CC BY-NC-SA 4.0**) — PSB format understanding draws on the format description in `PsbHeader.cs` / `Psb.cs` / `PsbValues.cs`; model packing and verification used its CLI toolkit FreeMoteToolkit v4.9.0 (`PsBuild.exe` / `PsbDecompile.exe`). **No FreeMote code or binary is included.**
- **[fflate](https://github.com/101arrowz/fflate)** (MIT) — `libs/fflate.js`.
- **E-mote SDK** — © M2 Co., Ltd. Proprietary; not distributed here.

## License

**Code**: [AGPL-3.0](LICENSE). This project started from [NekoWebShow](https://github.com/Chocola-X/NekoWebShow) (also AGPL-3.0), so the work as a whole remains under AGPL-3.0.

> AGPL section 13: if you deploy a modified version of this project as a publicly reachable network service, you must offer the corresponding source to its users.

**Assets and the E-mote runtime** are not included in this repository and are not covered by its license. Models, artwork and voice data belong to MAGES. / Nitroplus; the E-mote SDK belongs to M2 Co., Ltd., whose terms forbid redistribution and commercial use. Running the project therefore requires you to obtain these files lawfully and to comply with their terms.

This is why the project cannot be used commercially and offers no live demo — because there are no assets or runtime that could be distributed, not because the AGPL code above carries an added restriction.

## Disclaimer

- For technical research and study only. No original game assets are provided or distributed.
- Models, backgrounds and voice must be supplied by the user; copyright remains with the respective owners.
- "STEINS;GATE" and related characters are trademarks or registered trademarks of MAGES. / Nitroplus.
- If a rights holder objects to this project, please open an issue and it will be addressed promptly.
