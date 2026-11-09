# Account Fetcher (shareable copy, 2026-11-09)

For **raid & push** planning: one export carries everything both need.

Exports a snapshot of your Endless Frontier 2 account to one JSON file: every hero you own (copies per
ascend tier, fielded levels and medals), every relic (grade, trans, limit break, enhance), all hero and
relic presets, pets and pet points, runes, the castle's gold and medal levels, the level caps, the medal
wallet and accumulated medals, your max wave and the gameplay totals. Each file carries the **capture
date** (`takenAt` / `capturedAt`) and the **game version** it was taken on (`gameVersion`, read from the
installed bundle), so whoever receives it knows exactly which account state and which patch it describes.

**Read-only.** The plugin never sends anything to the game server and never changes your account. It only
reads the data objects the game itself fills while you play. The one file it fetches is its own bundled
`locale-en.json` (hero / relic names), from the plugin folder.

## Install

Copy BOTH folders into the local runtime's `plugins/` folder, next to the other plugins:

```text
plugins/
  account-fetcher/        (plugin.json, plugin.js, locale-en.json, viewer.html)
  shared/plugin-gate.js   (the Config-gate helper the plugin imports; skip if you already have it)
```

Restart the local server (it discovers `plugins/*/plugin.json`), then tick **Account Fetcher** in the
runtime's Config panel. Unticked = the plugin does nothing at all.

## One-time setup: open these screens once

The game fills its data lazily, so each piece is captured the first time you open its screen (any order):

1. **Hero roster** (the hero list)
2. **Relic screen**
3. **Pet screen**
4. **Castle screen** (tap the main castle)
5. **Guild Raid -> emblem / rune screen** (only needed if you want the runes in the export)
6. The **hero bulk-level popup** (x1000 / x100 / x10 / x1), if the "max-level cap" row stays unticked

The plugin's panel shows a checklist and ticks each piece as it is captured.

## Export

Click **Export JSON** in the panel once everything is ticked. A file named
`ef2-account-<timestamp>.json` is downloaded. Send that file. Nothing else is needed: the version and the
date are inside it.

Console alternative: `__EF_ACCOUNT_FETCHER__.dumpJson()` downloads the same file,
`__EF_ACCOUNT_FETCHER__.debug()` shows what has been captured so far.

## What the receiver gets

```json
{ "__ef_account_fetcher__": 1,
  "takenAt": "2026-10-28T19:12:03.511Z", "capturedAt": "...", "gameVersion": "1.17.78",
  "heroes": [...], "deployedHeroes": [...], "relics": [...], "presets": {...}, "pets": [...], "petPoint": 0,
  "runes": {...}, "castle": { "goldLevel": 0, "medalLevel": 0 }, "caps": {...},
  "medal": 0, "accuMedal": 0, "maxWave": 0, "gameplayTotals": {...}, "profileFrames": [...], "rebirthSetup": {...},
  "castleAbilities": {...}, "ownRank": 0, "tribe": 0, "rebirthCount": 0 }
```

`viewer.html` (optional): open it in a browser and drop the JSON on it to read the export as tables.

## Troubleshooting

* A row never ticks: open its screen again; the Config box must be ticked before the screen is opened.
* `gameVersion` reads `unknown`: the runtime did not expose the bundle version; the date is still there,
  tell the receiver which version the game showed.
* Names are empty: `locale-en.json` is missing from the plugin folder.

## Raid section (2026-11-09)

The export also carries `raid`: the raid pet the game applies, the game's own ascend points per unit line (couple-pet bonus included) and your raid barracks' soldiers per stage. Open **Guild > Barracks** once before exporting so the barracks are included; raid planning uses all three.
