/*
 * EF2 Account Fetcher — read-only capture of hero roster, relic collection, hero/relic presets, pet
 * collection, castle progression state + the live-computed max-level cap, AND (new) the Spirit
 * Highlands favorites list, exported as one JSON snapshot for offline calculation (see tools/ef2-calc).
 *
 * Renamed/forked from the archived `account-data-export` plugin (Original Plugin files/) — same
 * proven capture logic for heroes/relics/presets/pets, kept intact. What's new here is the castle +
 * max-level-cap section, added to feed a "where would you realistically revive" calculation.
 *
 * Adds NO network requests of its own — everything is read straight off live singletons via
 * runtime.hooks.onObjectWithProperties + a constructor.name/duck-type check, same pattern every other
 * capture plugin in this project uses.
 *
 * Confirmed mechanics (decompiled from ef2 client 1.13.3 source — nothing here is guessed):
 *
 *   Heroes: `UnitDataManager` (singleton via getInstance()) holds TWO separate collections that must
 *   be merged for a complete roster — `list` (only your CURRENTLY DEPLOYED team, UnitVO entries with
 *   a scalar `trans` per copy) and `ownedUnitList` (every hero kind you own BY COUNT, OwnedUnitVO
 *   entries shaped `{kindNum, count, trans:[c1,c2,c3]}` — count = trans-0 copies, trans[] = copies at
 *   tiers 1/2/3). Deployed copies are NOT counted in ownedUnitList (confirmed: deployed heroes show
 *   ownedUnitList.trans all-zero) — the merge logic below (readOwnedUnits, ported from
 *   plugins/war-capture/capture.js) adds each deployed copy back in as +1 at its own tier so totals
 *   reflect everything actually owned. English names resolved via `AG.getText("UNIT_NAME_"+kindNum,
 *   book.name)` (confirmed: UnitVO.getNameKey() returns exactly this key format) — this plugin
 *   resolves the same key itself from a bundled locale-en.json rather than depending on the account's
 *   active in-game language. `UnitDataManager.totalTransPoint` (a plain own property, recalculated by
 *   the game itself in `recalcTotalTransPoint`) is captured directly alongside the roster — this is
 *   the exact "Ascend Points" total `HeroUpgradeManager.getMaxLevel()` folds in, per
 *   knowledge/19-ascend-points.md, so no need to reconstruct it from the roster ourselves.
 *
 *   Relics: `TreasureDataManager` holds `bookList` (every relic's static definition) plus
 *   `ownedList`/`equipedList` — confirmed that `setOwnedData()` mutates the SAME object referenced in
 *   `bookList`/`kindNumMap` in place (setting `enhance`/`trans`/`limitBreak` directly on it) before
 *   pushing that same reference into ownedList/equipedList, so those two arrays already carry both
 *   the static definition AND the live per-relic stats — no extra lookup needed. English names
 *   resolved via `TREASURE_NAME_<kindNum>`, same pattern as plugins/relic-book-export.
 *
 *   Presets: `UnitDataManager.heroPresets` (5 slots, always unlocked) is shaped
 *   `{slotId, label, team:[{kindNum, trans, enhance}]}` — trans/enhance ARE snapshotted per hero
 *   preset slot. `TreasureDataManager.presets` (5 slots, gated by `presetUnlocked`) is shaped
 *   `{slotId, label, kindNums:[], enhances:[]}` (class TreasurePresetVO) — only `enhance` is
 *   snapshotted per relic preset slot; `trans`/`limitBreak` are NOT (a relic kindNum is a unique
 *   singleton, so those stats live only on the relic itself, not per-preset) — this export cross-
 *   references each preset's kindNums against `TreasureDataManager.kindNumMap` to report the relic's
 *   CURRENT trans/limitBreak/enhance alongside the enhance value the preset itself saved.
 *
 *   Pets: `PetDataManager.list` holds pets you own or have knowledge of, each `{kindNum, grade,
 *   piece}` — `grade` 0 means known-of but not actually owned; `piece` is the fragment count
 *   (confirmed: the game's own canEvolve() check compares `piece` against a per-grade fragment-cost
 *   table exactly like a shard/fragment currency). English names resolved via `PET_NAME_<kindNum>`.
 *   `PetDataManager.getPetPoint()` (a real method, not reconstructed here) is called directly and
 *   captured alongside the roster — see knowledge/21-pet-system.md's "Pet Points" section.
 *
 *   Spirit Highlands favorites (NEW): `SpiritLandDataManager.favoritePets` (plain public number[],
 *   max 18, live-confirmed in ef2 client 1.13.3's own SpiritLandDataManager.ts) is the farming-
 *   priority list the player builds in-game — which pets they're actively targeting for fragments.
 *   Captured alongside `ticket`/`ticketMax`/`purchaseCount` (the account-wide daily-attempt pool that
 *   can cap total fragment income across every favorited pet even though no single stage's try-count
 *   is ticket-gated itself — see knowledge/21-pet-system.md's "Pet fragments" section). Says nothing
 *   about how many fragments each favorited pet still needs — that's PetDataManager's own per-pet
 *   `piece` field, already captured separately above.
 *
 *   Castle (NEW): `CastleDataManager` (singleton) exposes `castleLevel` (gold level, `bookList[0]
 *   .level`) and `castleEnhance` (medal level, a private `_enhance` field behind a getter). Captured
 *   via its own `castleVO` object, which is tagged `isCastle = true` at construction — the same
 *   disambiguator the client itself uses to avoid confusing it with a real hero VO.
 *
 *   Max-level cap (NEW): rather than reconstruct `HeroUpgradeManager.getMaxLevel()`'s formula
 *   ourselves (base-per-grade + maxLvBonus + petPoint + trans bonus + totalTransPoint + wyvernMaxLv —
 *   see knowledge/10-core-mechanics.md), this plugin captures the real `HeroUpgradeManager` singleton
 *   and calls its own real `getMaxLevel(grade, trans)` method directly — read-only, no state mutated,
 *   asking the game for the exact number rather than re-deriving it and risking drift. `getMaxLevel(5,
 *   0)` is the confirmed castle call shape (grade slot 5 reserved for the castle, trans always 0 —
 *   see knowledge/25-gold-economy.md).
 */

// RULE #1: the one network subscription (profile frames, below) is held through gatedSubscription, so it does not
// exist -- and the runtime clones no response for it -- while this plugin is unchecked in Config.
import { gatedSubscription } from "../shared/plugin-gate.js";

function isUnitDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "UnitDataManager"
        && Array.isArray(candidate.heroPresets) && Array.isArray(candidate.list) && Array.isArray(candidate.ownedUnitList));
}

function isTreasureDataManager(candidate) {
    // Only requires bookList (not presets too, unlike auto-progression-loop's relic-preset-switch
    // check) — confirmed via the decompiled constructor that `presets` is assigned AFTER bookList/
    // kindNumMap/equipedKindNums (the properties this plugin's hook watches), so at the exact
    // synchronous moment any of those fire, `presets` genuinely doesn't exist on the candidate yet.
    // Requiring it here would make the check permanently fail for every invocation. Matches the
    // proven-working check in plugins/relic-book-export/plugin.js.
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "TreasureDataManager"
        && Array.isArray(candidate.bookList));
}

function isPetDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "PetDataManager"
        && Array.isArray(candidate.list) && typeof candidate.bookMap === "object");
}

function isCastleDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "CastleDataManager"
        && Array.isArray(candidate.bookList)
        && candidate.castleVO && candidate.castleVO.isCastle === true);
}

function isHeroUpgradeManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "HeroUpgradeManager"
        && Array.isArray(candidate.acc)
        && typeof candidate.getMaxLevel === "function");
}

// NEW (2026-08-29): BuffManager — the single object that already knows every account-wide
// gameplay total the calculator was making the user type by hand.
//
// `getGameplayTotal(code)` returns the summed value for a `GameplayBuffType`, pooled across every
// registered source (treasures, hero unique skills, pet awakenings, castle abilities). That is
// exactly the number the consumer reads, so capturing it sidesteps re-deriving each contributor —
// and cannot drift from the game the way a reimplementation would.
//
// This is a pure read of live client state. No request is originated (see
// knowledge/00-working-rules.md's no-originated-network-calls rule).
function isBuffManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "BuffManager"
        && typeof candidate.getGameplayTotal === "function"
        && typeof candidate.getGameplayMultiplier === "function");
}

// The codes worth exporting, and what each answers for the wave calculator. Names match
// `GameplayBuffType` exactly — they are the keys the game itself uses.
var GAMEPLAY_CODES = [
    "elfsecret",      // total wave-skip %, already pooled: castle ability + fielded + owned fairies
    "godbless",       // God's Blessing proc %
    "gamespeed",      // base speed %
    "wavecall",       // Wave Call charge-rate %
    "doublewave",     // extra waves per call %
    "callofdawn",     // Night mode (Call of Twilight) charge-rate %
    "pluslv",         // +UnitLvl buff
    "maxlv",
    "castlelevelup",  // Citadel extra level
    "humansecret", "undeadsecret", "orcsecret", "retreat",
    "monstergold", "wavecleargold", "questgoldgain", "offlinespeed", "offlinemax"
];

// NEW 2026-10-04: the rebirth screen's own setup. On the rebirth screen the game switches to the REBIRTH team and the
// REBIRTH relic preset (user, 2026-10-04), and the medal payout reads them (`RebirthMedalManager.getExpectedMedal`).
// Both are server data the game loads itself -- `ReviveTeamDataManager.ensureLoaded()` (RunInfo / the game-over popup)
// and `ReviveTreasureDataManager.init()` -- so this only keeps references, never asks. Read at export:
//   reviveTeam      the saved rebirth team, `{kindNum, trans}` per slot (`loaded` false = the game has not loaded it yet:
//                   open the rebirth screen once)
//   reviveTreasures the saved rebirth relics, and the ones the payout will really use (`getEffectiveKindNums()`: owned only)
//   guildWar        `GuildWarBuffSource` rank / rankBuff / serverBuff (the medal buff is rankBuff + serverBuff)
//   medalMultiplier `BuffManager.getGameplayMultiplier("medal")` and its per-source split (`perSourceGameplay`)
//   expected        the game's own payout at a few waves: `getMedal` (base), `getExpectedNormalMedal` (fielded team),
//                   `getExpectedMedal` (the rebirth team when one is set) -- pure calculations, nothing sent.
function isReviveTeamDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "ReviveTeamDataManager"
        && Array.isArray(candidate.kindNums) && Array.isArray(candidate.trans)
        && typeof candidate.ensureLoaded === "function");
}

function isReviveTreasureDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "ReviveTreasureDataManager"
        && Array.isArray(candidate.kindNums) && typeof candidate.getEffectiveKindNums === "function");
}

function buildRebirthSetupExport(state) {
    var out = { reviveTeam: null, reviveTreasures: null, guildWar: null, medalMultiplier: null, medalSources: null, expected: null };
    var t = state.reviveTeamDataManager;
    if (t) {
        var kinds = t.kindNums || [], trans = t.trans || [];
        out.reviveTeam = {
            loaded: !!t.loaded,
            team: kinds.map(function (k, i) { return { kindNum: k, trans: trans[i] || 0 }; })
        };
    }
    var r = state.reviveTreasureDataManager;
    if (r) {
        var eff = null;
        try { eff = r.getEffectiveKindNums(); } catch (e) {}
        out.reviveTreasures = { loaded: !!r.loaded, kindNums: (r.kindNums || []).slice(), effective: eff ? eff.slice() : null };
    }
    var bm = state.buffManager;
    if (bm) {
        try { out.medalMultiplier = bm.getGameplayMultiplier("medal"); } catch (e) {}
        try {
            var src = {};
            bm.perSourceGameplay.forEach(function (codes, sid) {
                var v = codes.get("medal");
                if (v) { src[sid] = v; }
            });
            out.medalSources = src;
        } catch (e) {}
        try {
            var gw = bm.sources.get("guildWar");
            if (gw) { out.guildWar = { rank: gw.rank, rankBuff: gw.rankBuff, serverBuff: gw.serverBuff }; }
        } catch (e) {}
    }
    var m = state.rebirthMedalManager;
    if (m) {
        var waves = [8000, 8500, 9000];
        if (state.maxWave) { waves.push(state.maxWave); }
        out.expected = waves.map(function (w) {
            var row = { wave: w, base: null, normal: null, rebirthTeam: null };
            try { row.base = m.getMedal(w); } catch (e) {}
            try { row.normal = m.getExpectedNormalMedal(w); } catch (e) {}
            try { if (typeof m.getExpectedMedal === "function") { row.rebirthTeam = m.getExpectedMedal(w); } } catch (e) {}
            return row;
        });
    }
    return out;
}

// NEW 2026-10-15 (live 1.15.82): profile frames -> PlusLv. Each owned profile frame (floor waves, gifts, GW season /
// tournament places) adds an `own` PlusLv, and the frame shown on the CURRENT tribe's slot adds an `equip` part. The
// client keeps the data in the static class `ProfileDecoManager` (index.js: `e(Mc,"ProfileDecoManager"),
// n(Mc,"state",null)`), loaded by the game itself from `/profileDeco/getState` (the HUD Profile badge's update() ->
// `ProfileDecoManager.ensure()`; the decoration popup reloads it), and the total in the singleton
// `ProfileFrameBuffSource` (sourceId "profileFrame"), registered with BuffManager at start-up -- so
// `gameplayTotals.pluslv` already includes it. Read here, never asked for:
//   effect         `ProfileFrameBuffSource.effect`, the game's own getter `framePlusLv(state.frames ids, nowLook.frame)`
//                  -> {own, equip, total}; it also reads {0,0,0} while the state is not loaded yet (see `state`)
//   appliedPlusLv  BuffManager `perSourceGameplay.get("profileFrame").get("pluslv")`: the part inside gameplayTotals.pluslv
//                  (0 = the source adds nothing; null = source not registered / BuffManager not captured)
//   state          `ProfileDecoManager.state` as the game received it: {frames:[{id,...}], deco:{faces[4], frames[4], rep},
//                  floorFrames, faces}. A static class field is out of reach of onObjectWithProperties (it reports
//                  objects only, the class is a function), so this is the getState / save response's `body.state`:
//                  via JSON.parse when responses are encrypted (the very object the game stores), else via the plain
//                  response. null = not seen this session (plugin off at login): open the Profile decoration screen once.
function findProfileDecoState(parsed) {
    var body = (parsed && typeof parsed === "object") ? parsed.body : null;
    var s = (body && typeof body === "object") ? body.state : null;
    return (s && typeof s === "object" && Array.isArray(s.frames)
        && s.deco && typeof s.deco === "object" && Array.isArray(s.deco.frames)) ? s : null;
}

function buildProfileFramesExport(state) {
    var out = { effect: null, appliedPlusLv: null, state: null, stateSeenAt: null, stateSource: null };
    var bm = state.buffManager, src = null;
    try { src = (bm && bm.sources) ? bm.sources.get("profileFrame") : null; } catch (e) {}
    if (src) {
        try {
            var eff = src.effect;
            if (eff && typeof eff === "object") {
                out.effect = { own: Number(eff.own) || 0, equip: Number(eff.equip) || 0, total: Number(eff.total) || 0 };
            }
        } catch (e) {}
        try {
            var codes = bm.perSourceGameplay.get("profileFrame");
            out.appliedPlusLv = codes ? (Number(codes.get("pluslv")) || 0) : 0;
        } catch (e) {}
    }
    if (state.profileDeco) {
        out.state = plainCopy(state.profileDeco.state);
        out.stateSeenAt = state.profileDeco.seenAt;
        out.stateSource = state.profileDeco.source;
    }
    return out;
}

function buildGameplayTotalsExport(buffManager) {
    if (!buffManager) { return null; }
    var out = {};
    for (var i = 0; i < GAMEPLAY_CODES.length; i++) {
        var code = GAMEPLAY_CODES[i];
        try {
            var v = buffManager.getGameplayTotal(code);
            out[code] = (typeof v === "number" && isFinite(v)) ? v : null;
        } catch (e) { out[code] = null; }
    }
    return out;
}

// NEW: the castle's own ability levels — Castle Secret among them. `CastleDataManager` keeps these
// in `specialBookList`/`specialList` (the CASTLE_SPECIAL book), separate from the gold/medal levels
// already captured. Exported as raw {kindNum, level} pairs rather than interpreted, so a future
// reader can map them without this plugin having to know what each ability does.
function buildCastleAbilitiesExport(castleManager) {
    if (!castleManager) { return null; }
    // `specialBookList` is the confirmed field name (CastleDataManager.ts:19,
    // `public specialBookList: CastleVO[]`), populated from the server's own
    // `specialKindNums`/`specialLevels` pair — so each VO carries a real {kindNum, level}.
    var src = castleManager.specialBookList;
    if (!Array.isArray(src)) { return null; }
    var out = [];
    for (var i = 0; i < src.length; i++) {
        var vo = src[i] || {};
        var kindNum = Number(vo.kindNum);
        if (!isFinite(kindNum)) { continue; }
        out.push({
            kindNum: kindNum,
            level: Number(vo.level) || 0,
            value: (typeof vo.value === "number") ? vo.value : null
        });
    }
    return out;
}

// NEW (2026-08-29): RankingDataManager — the authoritative source for the account's OWN max wave.
//
// The leaderboard payload carries two different shapes, and only one of them is you:
//   * `data.rankList[]` -> `RankingVO {name, maxWave, accuWave, accuMedal, rank}` — other players,
//     and note it has NO `userId`.
//   * `data.userRank`   -> `UserRankVO {userId, name, maxWave, accuWave, accuMedal, rank}` — YOUR
//     row, present whether or not you are inside the top 100 the board displays.
//
// Reading the manager's `getMyRanking()` is unambiguous where a scan over parsed JSON is not, and
// it also yields `accuMedal` — accumulated medals earned, which is the figure the wave calculator
// wants as a budget (medals already spent are recoverable from the roster, but the unspent balance
// was not in the export at all).
function isRankingDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "RankingDataManager"
        && Array.isArray(candidate.myRankList) && Array.isArray(candidate.list)
        && typeof candidate.getMyRanking === "function");
}

// Every ranking tab the player has opened keeps its own `myRankList` slot, so this reads all of
// them and takes the best-populated one rather than whichever tab happens to be selected.
function buildOwnRankExport(rankingManager) {
    if (!rankingManager) { return null; }
    var best = null;
    var list = rankingManager.myRankList || [];
    for (var i = 0; i < list.length; i++) {
        var vo = list[i];
        if (!vo || typeof vo !== "object") { continue; }
        var maxWave = Number(vo.maxWave) || 0;
        if (maxWave <= 0 && !vo.userId) { continue; }
        if (best == null || maxWave > (Number(best.maxWave) || 0)) {
            best = {
                userId: vo.userId || null,
                name: vo.name || null,
                maxWave: maxWave || null,
                accuWave: Number(vo.accuWave) || null,
                // Accumulated medals EARNED — the budget figure, as distinct from medals already
                // spent (which the roster's own enhance levels give).
                accuMedal: Number(vo.accuMedal) || null,
                rank: Number(vo.rank) || null
            };
        }
    }
    return best;
}

// NEW: QuestDataManager - the idle gold-income "Quest" tab (25-gold-economy.md: "Idle gold
// (goldPerSec) is quest-driven, not wave-driven"). `goldPerSec` is a plain public property,
// summed live by the game itself (QuestDataManager.updateGoldPerSec / setData), so this is a
// direct read, nothing to compute.
function isQuestDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "QuestDataManager"
        && Array.isArray(candidate.list) && typeof candidate.goldPerSec === "number");
}

// NEW: SpiritLandDataManager - the Spirit Highlands farming-priority list
// (`favoritePets`, max 18 kindNums, live-confirmed in ef2 client 1.13.3's
// own SpiritLandDataManager.ts) plus the ticket count that caps how many
// attempts/day are actually available across whatever's favorited (see
// knowledge/21-pet-system.md "Pet fragments" section for the full mechanic
// - max 6 pieces/day per targeted pet if every attempt clears, gated by an
// account-wide ticket pool). `favoritePets` itself doesn't say how many
// fragments each favorited pet still needs - that's PetDataManager's own
// per-pet `piece` field, already captured separately by buildPetsExport.
function isSpiritLandDataManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "SpiritLandDataManager"
        && Array.isArray(candidate.favoritePets) && Array.isArray(candidate.bookList));
}

// NEW: RebirthMedalManager - added specifically to answer 40-open-questions.md #18 / 14-anomalies-
// and-bugs.md E29 ("which rebirth-medal payout path is actually live: table or formula"). `RL`/`zF`
// (the class's own minified internal binding, tagged with the real name via `zt(zF,"RebirthMedalManager")`
// in the live bundle - the same "class tag" pattern goldman-revive's own header already documents for
// GoldGoblin) is NOT a window global, so it can't be read from the console directly - this catches the
// singleton instance the same way every other manager here is caught, via a property-detector hook.
// `medals`/`segments` are both assigned in the constructor itself (qt(this,"medals",[]),
// qt(this,"segments",[])), so they're present on the instance from the moment it's constructed, before
// any book data even loads - this should be catchable very early, likely without needing to visit any
// specific screen (RebirthMedalManager backs the always-visible MPM HUD widget, not just the Rebirth
// popup). `useFormula` itself is a getter (segments.length!==0 && 1==ClientDataManager.getClientData(
// "REBIRTH_MEDAL_USE_FORMULA")) - reading it here, once captured, needs no further hook.
function isRebirthMedalManager(candidate) {
    return !!(candidate && typeof candidate === "object"
        && candidate.constructor && candidate.constructor.name === "RebirthMedalManager"
        && Array.isArray(candidate.medals) && Array.isArray(candidate.segments)
        && typeof candidate.getMedal === "function"
        && typeof candidate.getExpectedNormalMedal === "function");
}

// CORRECTION (before this ever shipped): the castle gold-level (Durability, kindNum 1) buy cost
// does NOT need its own renderer capture at all. Read directly in `CastleItemRenderer.ts`
// (line ~589-611): `const manager = HeroUpgradeManager.getInstance(); ... this.btnBuyCost =
// manager.getTotalGold(uvo.level, uvo.level + 1)` - castle gold-level reuses the EXACT SAME
// cumulative gold-cost curve (`acc`) as hero leveling, the same `HeroUpgradeManager` instance
// already captured above for the max-level cap. The CASTLE book's own initCost/incCost for
// kindNum 1 being -1 isn't a missing-data gap to work around with a live renderer read - it's -1
// BECAUSE the cost genuinely comes from a different manager entirely, not this book row. So
// exporting the raw `acc` array (see buildCapsExport below) is both simpler and more robust than
// hunting for a specific on-screen button - no Castle-screen visit required at all.

function plainCopy(value, depth) {
    depth = depth || 0;
    if (depth > 6 || value == null) { return value; }
    if (Array.isArray(value)) { return value.map(function (v) { return plainCopy(v, depth + 1); }); }
    if (value instanceof Map) {
        var out = {};
        value.forEach(function (v, k) { out[k] = plainCopy(v, depth + 1); });
        return out;
    }
    if (typeof value === "object") {
        var result = {};
        for (var key in value) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) { continue; }
            var v = value[key];
            if (typeof v === "function") { continue; }
            result[key] = plainCopy(v, depth + 1);
        }
        return result;
    }
    return value;
}

var localeDataPromise = null;
function loadLocaleData() {
    if (!localeDataPromise) {
        // Bug fixed (inherited from account-data-export): a plain relative fetch("./locale-en.json")
        // resolves against the PAGE's base URL (document.baseURI), not this module's own URL —
        // plugins are served at /__ef_plugins__/<pluginId>/<file> (confirmed in
        // scripts/runtime_server/plugins.py), which doesn't match wherever the main game page itself
        // is hosted, so the plain-relative fetch 404s silently (caught below) and every name falls
        // back to the raw, un-translated book name. import.meta.url IS reliably the module's own real
        // URL regardless of the page's location, so resolving against that instead makes this work no
        // matter where the page is served from.
        localeDataPromise = fetch(new URL("./locale-en.json", import.meta.url))
            .then(function (res) { return res.ok ? res.json() : null; })
            .catch(function () { return null; });
    }
    return localeDataPromise;
}

function resolveText(localeData, key, fallback) {
    if (!localeData || key == null) { return fallback; }
    var value = localeData[key];
    return (value == null || value === "") ? fallback : value;
}

function resolveUnitName(kindNum, book, localeData) {
    return resolveText(localeData, "UNIT_NAME_" + kindNum, (book && book.name) || ("Hero #" + kindNum));
}
function resolveTreasureName(kindNum, book, localeData) {
    return resolveText(localeData, "TREASURE_NAME_" + kindNum, (book && book.name) || ("Relic #" + kindNum));
}
function resolvePetName(kindNum, book, localeData) {
    return resolveText(localeData, "PET_NAME_" + kindNum, (book && book.name) || ("Pet #" + kindNum));
}

function downloadText(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

// ---- category builders --------------------------------------------------------------------------

// Ported from plugins/war-capture/capture.js's readOwnedUnits() — merges `ownedUnitList` (owned
// counts by tier, deployed copies excluded) with `list` (deployed copies, added back in at their own
// tier) into one per-kindNum record. `trans` = highest tier owned at all (deployed or not);
// `transCounts` keeps the full [tier0, tier1, tier2, tier3] copy-count breakdown.
function buildHeroesExport(unitManager, localeData) {
    if (!unitManager || !Array.isArray(unitManager.ownedUnitList)) { return null; }
    var byKind = {};
    function vo(k) { try { return typeof unitManager.getBookVO === "function" ? unitManager.getBookVO(k) : null; } catch (e) { return null; } }
    function rec(k) {
        if (byKind[k]) { return byKind[k]; }
        var b = vo(k) || {};
        return (byKind[k] = {
            kindNum: Number(k),
            name: resolveUnitName(k, b, localeData),
            tribe: b.tribe != null ? Number(b.tribe) : null,
            grade: b.grade != null ? Number(b.grade) : null,
            level: null, enhance: null,
            owned: false, deployed: false, deployedCount: 0,
            trans: 0, transCounts: [0, 0, 0, 0]
        });
    }
    try {
        for (var i = 0; i < unitManager.ownedUnitList.length; i++) {
            var o = unitManager.ownedUnitList[i]; if (!o || o.kindNum == null) { continue; }
            var r = rec(o.kindNum); r.owned = true;
            var tc = [Number(o.count) || 0, 0, 0, 0];
            if (Array.isArray(o.trans)) { for (var ti = 0; ti < 3; ti++) { tc[ti + 1] = Number(o.trans[ti]) || 0; } }
            r.transCounts = tc;
            var mx = 0; for (var t2 = 3; t2 >= 1; t2--) { if (tc[t2] > 0) { mx = t2; break; } }
            r.trans = Math.max(r.trans, mx);
        }
    } catch (e) {}
    try {
        // Bug fixed (found after a live account showed plusLv +215 vs this export's +20):
        // `deployed` was only ever a boolean ("is at least one copy fielded"), so a preset/team
        // fielding the SAME kind more than once (confirmed real — hero presets already showed
        // this for maxLv) was invisible for the CURRENT team too. `unitManager.list` has one real
        // entry PER DEPLOYED COPY, so counting loop iterations per kindNum (not just setting a
        // flag) gives the real fielded count, same fix class as the preset multi-slot counting.
        for (var j = 0; j < unitManager.list.length; j++) {
            var u = unitManager.list[j]; if (!u || u.kindNum == null) { continue; }
            var d = rec(u.kindNum); d.owned = true; d.deployed = true;
            d.deployedCount = (d.deployedCount || 0) + 1;
            var ut = (typeof u.trans === "number") ? u.trans : 0; ut = ut < 0 ? 0 : (ut > 3 ? 3 : ut);
            d.transCounts[ut] = (d.transCounts[ut] || 0) + 1;
            d.trans = Math.max(d.trans, ut);
            if (u.level != null) { d.level = Number(u.level); }
            if (u.enhance != null) { d.enhance = Number(u.enhance); }
            // Per-instance capture (2026-09-05): a team can field the same kind at DIFFERENT
            // levels/medals (a real 4x Druid II push squad ran 2560/+4190, 2580/+4170,
            // 2600/+4150, 2620/+4130 -- the per-kind row above kept only the last one seen).
            // `instances` keeps every deployed copy in team order; the calc reads it when present.
            if (!Array.isArray(d.instances)) { d.instances = []; }
            d.instances.push({
                slot: j,
                level: u.level != null ? Number(u.level) : null,
                enhance: u.enhance != null ? Number(u.enhance) : null,
                trans: ut
            });
        }
    } catch (e) {}
    var out = [];
    for (var k in byKind) { if (Object.prototype.hasOwnProperty.call(byKind, k)) { out.push(byKind[k]); } }
    out.sort(function (a, b) { return a.kindNum - b.kindNum; });
    return out;
}

// Flat per-deployed-copy list in team order (2026-09-05) -- one row per fielded hero instance,
// independent of kind. `heroes[]` above stays per-kind for the readers that already consume it.
function buildDeployedHeroesExport(unitManager, localeData) {
    if (!unitManager || !Array.isArray(unitManager.list)) { return null; }
    var out = [];
    try {
        for (var j = 0; j < unitManager.list.length; j++) {
            var u = unitManager.list[j]; if (!u || u.kindNum == null) { continue; }
            var b = null; try { b = typeof unitManager.getBookVO === "function" ? unitManager.getBookVO(u.kindNum) : null; } catch (e) {}
            var ut = (typeof u.trans === "number") ? u.trans : 0; ut = ut < 0 ? 0 : (ut > 3 ? 3 : ut);
            out.push({
                slot: j,
                kindNum: Number(u.kindNum),
                name: resolveUnitName(u.kindNum, b || {}, localeData),
                level: u.level != null ? Number(u.level) : null,
                enhance: u.enhance != null ? Number(u.enhance) : null,
                trans: ut
            });
        }
    } catch (e) {}
    return out;
}

// ownedList/equipedList entries already carry both the static book fields AND the live
// enhance/trans/limitBreak (see header comment) — no extra kindNumMap lookup needed here.
function buildRelicsExport(treasureManager, localeData) {
    if (!treasureManager) { return null; }
    var equippedSet = {};
    (treasureManager.equipedKindNums || []).forEach(function (k) { equippedSet[k] = true; });
    var owned = (treasureManager.ownedList || []).concat(treasureManager.equipedList || []);
    var seen = {};
    var out = [];
    owned.forEach(function (r) {
        if (!r || r.kindNum == null || seen[r.kindNum]) { return; }
        seen[r.kindNum] = true;
        out.push({
            kindNum: r.kindNum,
            name: resolveTreasureName(r.kindNum, r, localeData),
            grade: r.grade != null ? Number(r.grade) : null,
            trans: Number(r.trans) || 0,
            limitBreak: Number(r.limitBreak) || 0,
            enhance: Number(r.enhance) || 0,
            equipped: !!equippedSet[r.kindNum]
        });
    });
    out.sort(function (a, b) { return a.kindNum - b.kindNum; });
    return out;
}

function buildHeroPresetsExport(unitManager, localeData) {
    if (!unitManager || !Array.isArray(unitManager.heroPresets)) { return null; }
    var activeSlot = typeof unitManager.getActiveHeroPresetSlot === "function" ? unitManager.getActiveHeroPresetSlot() : -1;
    return unitManager.heroPresets.map(function (preset, index) {
        return {
            slotId: index,
            label: preset.label || "",
            active: activeSlot === index,
            team: (preset.team || []).map(function (member) {
                var book = typeof unitManager.getBookVO === "function" ? unitManager.getBookVO(member.kindNum) : null;
                return {
                    kindNum: member.kindNum,
                    name: resolveUnitName(member.kindNum, book, localeData),
                    trans: Number(member.trans) || 0,
                    enhance: Number(member.enhance) || 0
                };
            })
        };
    });
}

// Relic presets only snapshot `enhance` per slot (enhanceAtSave) — trans/limitBreak are live-only
// stats (a relic kindNum is a unique singleton), so those are cross-referenced from kindNumMap here
// under `current`, separately from what the preset itself saved.
function buildRelicPresetsExport(treasureManager, localeData) {
    if (!treasureManager || !Array.isArray(treasureManager.presets)) { return null; }
    var activeSlot = typeof treasureManager.getActivePresetSlot === "function" ? treasureManager.getActivePresetSlot() : -1;
    var kindNumMap = treasureManager.kindNumMap;
    return treasureManager.presets.map(function (preset, index) {
        var kindNums = preset.kindNums || [];
        var enhances = preset.enhances || [];
        return {
            slotId: index,
            label: preset.label || "",
            active: activeSlot === index,
            relics: kindNums.map(function (kindNum, i) {
                var live = kindNumMap && typeof kindNumMap.get === "function" ? kindNumMap.get(kindNum) : null;
                return {
                    kindNum: kindNum,
                    name: resolveTreasureName(kindNum, live, localeData),
                    enhanceAtSave: enhances[i] != null ? Number(enhances[i]) : null,
                    current: live ? { trans: Number(live.trans) || 0, limitBreak: Number(live.limitBreak) || 0, enhance: Number(live.enhance) || 0 } : null
                };
            })
        };
    });
}

function buildPetsExport(petManager, localeData) {
    if (!petManager || !Array.isArray(petManager.list)) { return null; }
    // Bug fixed: `grade > 0` treated "not yet evolved to grade 1" as "not owned" and silently
    // dropped the pet entirely — but a pet can have real fragments/shards toward its first
    // evolution (confirmed live: "Sark", 1 shard, 9 Pet Points, visible skill values) while still
    // sitting at grade 0. Its skill1 contributed a real +10 to a live account's plusLv total that
    // this filter was making invisible to any downstream calculation. Now keeps any pet with
    // fragments in progress too, not just grade>=1 — a pet truly never touched (grade 0, piece 0)
    // is still excluded, since that genuinely is "known-of but not owned" (per the original
    // account-data-export README's own definition of grade 0).
    return petManager.list.filter(function (p) { return p && (p.grade > 0 || p.piece > 0); }).map(function (owned) {
        var book = typeof petManager.getBookVO === "function" ? petManager.getBookVO(owned.kindNum)
            : (petManager.bookMap && typeof petManager.bookMap.get === "function" ? petManager.bookMap.get(owned.kindNum) : null);
        return {
            kindNum: owned.kindNum,
            name: resolvePetName(owned.kindNum, book, localeData),
            grade: owned.grade,
            fragments: owned.piece,
            represented: petManager.representPet === owned.kindNum,
            revive: petManager.revivePet === owned.kindNum
        };
    }).sort(function (a, b) { return (b.grade - a.grade) || (b.fragments - a.fragments); });
}

function buildFavoritePetsExport(spiritLandManager) {
    if (!spiritLandManager || !Array.isArray(spiritLandManager.favoritePets)) { return null; }
    return {
        favoritePets: spiritLandManager.favoritePets.slice(),
        ticket: typeof spiritLandManager.ticket === "number" ? spiritLandManager.ticket : null,
        ticketMax: typeof spiritLandManager.ticketMax === "number" ? spiritLandManager.ticketMax : null,
        purchaseCount: typeof spiritLandManager.purchaseCount === "number" ? spiritLandManager.purchaseCount : null
    };
}

// NEW: castle progression state — gold level (castleLevel) and medal level (castleEnhance).
function buildCastleExport(castleManager) {
    if (!castleManager) { return null; }
    var vo = castleManager.castleVO || {};
    return {
        goldLevel: Number(castleManager.castleLevel) || 0,
        medalLevel: Number(castleManager.castleEnhance) || 0,
        kindNum: vo.kindNum != null ? Number(vo.kindNum) : null
    };
}

// NEW: the live-computed max-level cap, read straight from the game's own HeroUpgradeManager rather
// than reconstructed from the formula's individual terms — asking the game for the number instead of
// re-deriving it avoids drift if any term changes on a future patch.
function buildCapsExport(heroUpgradeManager, unitManager) {
    if (!heroUpgradeManager || typeof heroUpgradeManager.getMaxLevel !== "function") { return null; }
    var out = { castleMaxLevel: null, heroMaxLevelByGrade: {}, totalTransPoint: null, goldCostAcc: null };
    try { out.castleMaxLevel = Number(heroUpgradeManager.getMaxLevel(5, 0)); } catch (e) {}
    // Grades 1-6 for reference — trans=0 baseline per grade (a specific hero's real cap also adds its
    // own trans*100, computed client-side, not captured here).
    for (var g = 1; g <= 6; g++) {
        try { out.heroMaxLevelByGrade[g] = Number(heroUpgradeManager.getMaxLevel(g, 0)); } catch (e) {}
    }
    if (unitManager && typeof unitManager.totalTransPoint === "number") {
        out.totalTransPoint = unitManager.totalTransPoint;
    }
    // goldCostAcc: the SAME cumulative gold-cost array (`acc[level]` = total gold spent reaching
    // that level from 0) HeroUpgradeManager uses for hero leveling — castle gold-level (Durability)
    // reuses it identically via `getTotalGold(from, to)` (confirmed, CastleItemRenderer.ts:589-611:
    // `HeroUpgradeManager.getInstance().getTotalGold(uvo.level, uvo.level + 1)`). Exporting the raw
    // array lets a calculator do O(1) `acc[to] - acc[from]` lookups exactly like the medal-cost
    // curve already does in tools/ef2-calc. Can be large (thousands of entries) but each is a plain
    // number, same order of magnitude as the medal segment table already handled fine.
    try {
        if (Array.isArray(heroUpgradeManager.acc)) {
            out.goldCostAcc = heroUpgradeManager.acc.map(Number);
        }
    } catch (e) {}
    return out;
}

// NEW: account maxWave (best rebirth wave), needed to know whether the Citadel wave-gate
// (maxWave >= 100, see HeroUniqueSkillDataManager.CITADEL_UNLOCK_WAVE) is actually open for the
// OWNERSHIP_BASED_CODES unique skills (Steam Punk's castleLevelUp among them). `UserInfoManager
// .maxWave` is a STATIC class field (`public static maxWave: number = 1`), not an instance
// property — there is no live object to catch via onObjectWithProperties the way every other
// capture in this plugin works. It arrives from the server as a plain `maxWave` field on parsed
// JSON payloads instead (confirmed call sites: `UserInfoManager.safeNum(user.maxWave, ...)` and
// `...(item.maxWave, ...)`), so this is read the same way `war-capture`'s network-log style
// plugins do — passively, via runtime.hooks.onJsonParse, never originating a request of its own
// (see knowledge/00-working-rules.md's no-originated-network-calls rule; this only ever reads
// traffic the game already sent). Keeps the HIGHEST value seen, since best-wave is monotonic.
// **BUG, found 2026-08-29**: this used to keep the HIGHEST `maxWave` seen in any parsed payload,
// which is wrong the moment a leaderboard or guild roster arrives — those carry OTHER players'
// best waves. On the reference account it captured **8368** while the account's real max wave is
// **7080**, and every consumer that trusted the export inherited that error.
//
// The fix is to accept `maxWave` only from an object that also looks like the local user's own
// record. `UserInfoManager` reads it as `user.maxWave`, alongside the account's own currency and
// identity fields, whereas a leaderboard row carries a rank/score shape instead. Requiring one of
// those companion fields rejects other players' rows without needing to know the local user id.
// The leaderboard's own answer to "which row is mine": `data.userRank`. `RankingDataManager.setData`
// reads exactly this key, and the surrounding `rankList[]` rows carry no `userId` at all — so an
// object holding both `userId` and `maxWave` is the local user's row and nobody else's.
function scanForUserRank(value, depth, out) {
    if (depth > 5 || value == null || typeof value !== "object") { return; }
    var ur = value.userRank;
    if (ur && typeof ur === "object" && typeof ur.maxWave === "number") {
        if (out.maxWave == null || ur.maxWave > out.maxWave) { out.maxWave = ur.maxWave; }
        if (typeof ur.accuMedal === "number") { out.accuMedal = ur.accuMedal; }
        if (typeof ur.accuWave === "number") { out.accuWave = ur.accuWave; }
        if (ur.userId) { out.userId = ur.userId; }
    }
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) { scanForUserRank(value[i], depth + 1, out); }
        return;
    }
    for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) { continue; }
        scanForUserRank(value[key], depth + 1, out);
    }
}

function looksLikeOwnUserRecord(value) {
    if (value == null || typeof value !== "object") { return false; }
    var OWN_ONLY = ["medal", "crystal", "gold", "rebirthCount", "tribe", "trans", "userId", "uid"];
    for (var i = 0; i < OWN_ONLY.length; i++) {
        if (Object.prototype.hasOwnProperty.call(value, OWN_ONLY[i])) { return true; }
    }
    return false;
}

function scanForMaxWave(value, depth, out) {
    if (depth > 4 || value == null || typeof value !== "object") { return; }
    if (typeof value.maxWave === "number" && isFinite(value.maxWave) && value.maxWave > 0
        && looksLikeOwnUserRecord(value)) {
        if (out.maxWave == null || value.maxWave > out.maxWave) { out.maxWave = value.maxWave; }
        // The same record carries the medal WALLET, which the export never had. Medals already
        // spent are recoverable from the roster; the unspent balance is not, and the calculator's
        // budget needs both (measured: 430.14c spent vs a 487c real total).
        if (typeof value.medal === "number" && isFinite(value.medal)) { out.medal = value.medal; }
        // `accuMedal` is accumulated medals EARNED — `UserInfoManager.accuMedal`, the figure the
        // Profile popup renders in the game's own large-number notation ("487c"). That is the
        // budget the wave calculator wants: medals already spent are recoverable from the roster's
        // enhance levels, but only this includes what is still unspent.
        if (typeof value.accuMedal === "number" && isFinite(value.accuMedal)) {
            out.accuMedal = value.accuMedal;
        }
        if (typeof value.tribe === "number" && isFinite(value.tribe)) { out.tribe = value.tribe; }
        if (typeof value.rebirthCount === "number") { out.rebirthCount = value.rebirthCount; }
    }
    // Anything with a maxWave that is NOT our own record is recorded once, so the export can say
    // it saw leaderboard data rather than silently ignoring it.
    if (typeof value.maxWave === "number" && !looksLikeOwnUserRecord(value)) {
        out.foreignMaxWaveSeen = true;
    }
    if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) { scanForMaxWave(value[i], depth + 1, out); }
        return;
    }
    for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) { continue; }
        scanForMaxWave(value[key], depth + 1, out);
    }
}

// ---- overlay UI -----------------------------------------------------------------------------------

function efPluginOff(id) {
    try {
        var node = document.querySelector('[data-ef-plugin-overlay="' + id + '"]');
        return !!node && node.style.display === "none";
    } catch (e) { return false; }
}


// ── Rune inventory (added 2026-08-28) ────────────────────────────────────────────────────────
// Answers "which runes can I actually test?" for ef2-war-engine's rune search, so a sweep can be
// restricted to what this account owns AND at which grade, instead of every catalog rune at
// Mythic.
//
// Read-only, same as every other capture here: `RuneDataManager` is a game singleton
// (`src/game/manager/data/RuneDataManager.ts`) that the game itself populates from its OWN
// `/rune/getAll` PULL when you open the rune screen. This plugin never originates that request —
// see knowledge/00-working-rules.md's no-originated-network-calls rule.
//
// Shape is the client's own `UserRuneVO { id, kindNum, grade, subId, level, locked }`, held in a
// `runes: Map<number, UserRuneVO>`; `slots: number[][]` is the 6-slot loadout (corps 1-5 plus the
// crossbow at index 5) as rune IDs.
//
// ⚠️ Worth knowing when reading the output: `RuneDataManager.TEST_SEED_INVENTORY` is `true` in the
// client, and dev-grants one of every rune type the first time you open a type you own none of
// (its own comment says it must be turned OFF before release). So ownership may well be "all of
// them" — in which case the REAL constraint on a search is the per-rune GRADE, not whether you
// have it. `maxGradeByKind` below is the field that actually matters for that.
function isRuneDataManager(o) {
    return !!o && o.runes && typeof o.runes.forEach === "function"
        && Array.isArray(o.slots) && typeof o.getEquippedIdSet === "function";
}

// ── Raid section (added 2026-11-09, for raid planning) ──────────────────────────────────────────────
// What a guild raid fields, read off the game's own objects, nothing reconstructed:
//
// - `raidPet`: `PetDataManager.raidPet` (0 = not set) and `getEffectiveRaidPet()` (falls back to the represented
//   pet — the pet whose RAIDHU_A / RAIDASU_A / RAIDARU_A buff and doubled resist the raid applies).
// - `transPointsByBase`: `UnitDataManager.heroTransPointCache`, the game's own ascend points per unit LINE
//   (keyed by the book's `base`, so a hero and its evolutions, a soldier and its tiers share one entry), with the
//   couple-pet ×1.5 already applied (`calcHeroTransPoint`). `getTransPointMultiplier(kind)` = 1 + min(points,100)/100
//   is what `applyRawAllyStats` multiplies every raid ally by.
// - `barracks`: NOT captured since 2026-11-10 (always null): raid planning takes every soldier corps as 30 at the top
//   tier, the last tier when the tribe's awakening pet is 5★ (`awakenedTribes`), so no screen has to be opened for it.
//   The reader below stays for reference. Was: `GuildBarracksDataManager` (filled when the Guild > Barracks screen or a raid battle-ready popup
//   loads the states). Per unlocked barrack: its book row (`unitKindNums`, `plusLevel` per stage 0-4, `maxNum`) and
//   the RAID pool's soldiers per stage as the raid would spawn them now (`computeSoldiers(book, state, instructors,
//   Date.now(), "raid")`) and fully trained (`computeSoldiersFull`). The tribe's awakening pet at 5★ shifts every
//   stage one up (PetAwakeningEffects.getShiftedSoldierTier); `awakenedTribes` lists those tribes from the pet list.
function isGuildBarracksDataManager(o) {
    return !!o && Array.isArray(o.bookList) && o.states && typeof o.states.get === "function"
        && typeof o.computeSoldiers === "function" && typeof o.getState === "function";
}

function buildRaidExport(petManager, unitManager, barracksManager) {
    var out = { raidPet: null, transPointsByBase: null, barracks: null, awakenedTribes: null };
    try {
        if (petManager) {
            var eff = typeof petManager.getEffectiveRaidPet === "function" ? Number(petManager.getEffectiveRaidPet()) : 0;
            var effVo = petManager.objList && typeof petManager.objList.get === "function" ? petManager.objList.get(eff) : null;
            out.raidPet = { set: Number(petManager.raidPet) || 0, effective: eff || 0, grade: effVo ? Number(effVo.grade) || 0 : 0 };
            var aw = [];
            var awakening = { 23: 1, 24: 2, 25: 3, 26: 4 };
            Object.keys(awakening).forEach(function (k) {
                var vo = petManager.objList && typeof petManager.objList.get === "function" ? petManager.objList.get(Number(k)) : null;
                if (vo && Number(vo.grade) >= 5) { aw.push(awakening[k]); }
            });
            out.awakenedTribes = aw;
        }
    } catch (e) {}
    try {
        if (unitManager && unitManager.heroTransPointCache && typeof unitManager.heroTransPointCache.forEach === "function") {
            var tp = {};
            unitManager.heroTransPointCache.forEach(function (v, k) { tp[String(k)] = Number(v) || 0; });
            out.transPointsByBase = tp;
        }
    } catch (e) {}
    try {
        if (barracksManager && barracksManager.bookList && barracksManager.bookList.length) {
            var rows = [];
            barracksManager.bookList.forEach(function (book) {
                var st = barracksManager.getState(book.tribe);
                if (!st) { return; }
                var unlocked = Array.isArray(st.unlockedKinds) && st.unlockedKinds.indexOf(book.kindNum) >= 0;
                var instructors = typeof barracksManager.computeInstructorsForBarrack === "function" ? barracksManager.computeInstructorsForBarrack(book) : [];
                var now = null, full = null;
                try { now = barracksManager.computeSoldiers(book, st, instructors, Date.now(), "raid"); } catch (e) {}
                try { full = typeof barracksManager.computeSoldiersFull === "function" ? barracksManager.computeSoldiersFull(book, st, instructors, "raid") : null; } catch (e) {}
                rows.push({
                    kind: book.kindNum, tribe: book.tribe, unlocked: unlocked, maxNum: book.maxNum || 30,
                    unitKindNums: (book.unitKindNums || []).slice(), plusLevel: (book.plusLevel || []).slice(),
                    raidNow: now ? now.slice() : null, raidFull: full ? full.slice() : null,
                    instructors: (instructors || []).map(function (i) { return { hero: i.heroKindNum, trans: i.trans, grade: i.grade, maxStage: i.maxTrainableStage }; })
                });
            });
            out.barracks = { capturedAt: new Date().toISOString(), rows: rows };
        }
    } catch (e) {}
    return out;
}

// NEW 2026-11-10: the Runes row never ticked for some sessions. The capture above only sees RuneDataManager at the
// moment the game constructs it (a property-definition hook); when the game builds it before this plugin attaches,
// it is missed for the whole session. Backup: the game's own /rune/getAll answer ({runes:[{id,kindNum,grade,subId,
// level,locked}], loadout:"ids|ids|...", presets}) as it passes JSON.parse or Response.json - the same object
// RuneDataManager.applyGetAll reads. Read-only, nothing is requested. Returns {runes, slots} or null.
function findRuneGetAll(value) {
    var cands = [value, value && value.body, value && value.data];
    for (var i = 0; i < cands.length; i++) {
        var b = cands[i];
        if (b && typeof b === "object" && Array.isArray(b.runes) && b.runes.length
            && b.runes[0] && b.runes[0].kindNum != null && b.runes[0].id != null && b.runes[0].grade != null) {
            // the game reads it as parseSlots(String(loadout ?? "")) - not always a string on the wire
            var lo = b.loadout == null ? "" : (Array.isArray(b.loadout) ? b.loadout.map(function (x) { return Array.isArray(x) ? x.join(",") : String(x); }).join("|") : String(b.loadout));
            var slots = lo.split("|");
            var out = [];
            for (var s = 0; s < 6; s++) {
                out.push(String(slots[s] || "").split(",").map(Number).filter(function (n) { return isFinite(n) && n > 0; }));
            }
            var runes = new Map();
            b.runes.forEach(function (r) {
                runes.set(Number(r.id), { id: Number(r.id), kindNum: Number(r.kindNum), grade: Number(r.grade),
                    subId: Number(r.subId != null ? r.subId : -1), level: Number(r.level || 0), locked: !!r.locked });
            });
            return { runes: runes, slots: out, fromResponse: true };
        }
    }
    return null;
}

function buildRunesExport(runeDataManager) {
    if (!runeDataManager) return null;
    var owned = [];
    var maxGradeByKind = {};
    try {
        runeDataManager.runes.forEach(function (r) {
            if (!r || typeof r.kindNum !== "number") return;
            owned.push({
                id: r.id, kindNum: r.kindNum, grade: r.grade,
                subId: r.subId, level: r.level, locked: !!r.locked
            });
            var k = String(r.kindNum);
            if (maxGradeByKind[k] == null || r.grade > maxGradeByKind[k]) {
                maxGradeByKind[k] = r.grade;
            }
        });
    } catch (e) { return null; }
    var equipped = [];
    try {
        for (var slot = 0; slot < runeDataManager.slots.length; slot++) {
            equipped.push((runeDataManager.slots[slot] || []).slice());
        }
    } catch (e) {}
    owned.sort(function (a, b) { return a.kindNum - b.kindNum || a.grade - b.grade; });
    return {
        count: owned.length,
        // kindNum -> highest grade owned. This is the field a rune search should filter on.
        maxGradeByKind: maxGradeByKind,
        // 6 slots of rune IDs: corps 1-5 then the crossbow (RuneDataManager.CROSSBOW_SLOT = 5).
        equippedSlots: equipped,
        owned: owned
    };
}


function installOverlay(state, dumpJson) {
    var PLUGIN_ID = "account-fetcher";
    var OVERLAY_ID = "ef-account-fetcher-overlay";
    if (document.getElementById(OVERLAY_ID)) { return { detach: function () {} }; }

    var style = document.createElement("style");
    style.id = OVERLAY_ID + "-style";
    var I = "#" + OVERLAY_ID;
    style.textContent = [
        I + "{position:fixed;top:42px;right:510px;z-index:2147483647;box-sizing:border-box;width:240px;padding:9px 11px;border:1px solid rgba(200,180,220,.35);border-radius:8px;background:rgba(0,0,0,.82);color:#e6d8f0;font-family:-apple-system,system-ui,sans-serif;font-size:12px;line-height:1.35}",
        I + " .ade-title{font-size:13px;font-weight:700;margin-bottom:6px;text-align:center;cursor:move;user-select:none}",
        I + " .ade-row{display:flex;align-items:baseline;gap:6px;margin-top:3px}",
        I + " .ade-ic{width:13px;font-weight:700;color:#7a6a8a}",
        I + " .ade-row.done .ade-ic{color:#43d17a}",
        I + " .ade-row.done .ade-lb{color:#9fe8bd}",
        I + " .ade-lb{color:#e6d8f0}",
        I + " .ade-btn{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:8px 10px;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:#5a3a7a;color:#fff;font:inherit;font-weight:600;cursor:pointer}",
        I + " .ade-btn:hover{filter:brightness(1.15)}",
        I + ".ade-collapsed > :not(.ade-title){display:none!important}"
    ].join("");
    document.head.appendChild(style);

    var node = document.createElement("div");
    node.id = OVERLAY_ID;
    node.setAttribute("data-ef-plugin-overlay", PLUGIN_ID);
    node.innerHTML =
        '<div class="ade-title">Account Fetcher <span style="float:right;cursor:pointer" class="ade-collapse-btn">-</span></div>' +
        '<div class="ade-row" data-key="unitDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Heroes (open Hero screen)</span></div>' +
        '<div class="ade-row" data-key="treasureDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Relics (open Relic screen)</span></div>' +
        '<div class="ade-row" data-key="petDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Pets (open Pet screen)</span></div>' +
        '<div class="ade-row" data-key="castleDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Castle (open Castle screen)</span></div>' +
        '<div class="ade-row" data-key="heroUpgradeManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Max-level cap (auto)</span></div>' +
        '<div class="ade-row" data-key="maxWave"><span class="ade-ic">\u25CB</span><span class="ade-lb">maxWave (auto, passive)</span></div>' +
        '<div class="ade-row" data-key="questDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">goldPerSec (open Quest screen)</span></div>' +
        '<div class="ade-row" data-key="rebirthMedalManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Rebirth medal formula (auto)</span></div>' +
        '<div class="ade-row" data-key="spiritLandDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Spirit Highlands favorites (open Pet &gt; Spirit Highlands)</span></div>' +
        '<div class="ade-row" data-key="buffManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Gameplay totals (auto)</span></div>' +
        '<div class="ade-row" data-key="rankingDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Own leaderboard row (open Ranking)</span></div>' +
        '<div class="ade-row" data-key="ownRank"><span class="ade-ic">\u25CB</span><span class="ade-lb">Real maxWave + accuMedal (open Ranking)</span></div>' +
        '<div class="ade-row" data-key="medal"><span class="ade-ic">\u25CB</span><span class="ade-lb">Medal wallet (auto, passive)</span></div>' +
        '<div class="ade-row" data-key="rebirthSetup"><span class="ade-ic">\u25CB</span><span class="ade-lb">Rebirth team + relics (open the rebirth screen)</span></div>' +
        '<div class="ade-row" data-key="runeDataManager"><span class="ade-ic">\u25CB</span><span class="ade-lb">Runes (open Guild Raid &gt; emblems)</span></div>' +
        '<div class="ade-row" data-key="profileFrames"><span class="ade-ic">\u25CB</span><span class="ade-lb">Profile frames (auto at login; else open Profile &gt; decoration)</span></div>' +
        '<button class="ade-btn" type="button">Export JSON</button>';
    document.body.appendChild(node);

    // Draggable header + persisted position + collapse toggle, matching the project's overlay
    // framing standard (see plugins/war-capture/overlay.js for the reference implementation).
    var POS_KEY = "__EF_PLUGIN__:" + PLUGIN_ID + ":overlay-pos";
    var COLLAPSED_KEY = "__EF_PLUGIN__:" + PLUGIN_ID + ":overlay-collapsed";
    try {
        var savedPos = JSON.parse(localStorage.getItem(POS_KEY) || "null");
        if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
            node.style.left = savedPos.left + "px";
            node.style.top = savedPos.top + "px";
            node.style.right = "auto";
        }
        if (localStorage.getItem(COLLAPSED_KEY) === "1") { node.classList.add("ade-collapsed"); }
    } catch (e) {}

    var titleEl = node.querySelector(".ade-title");
    var dragState = null;
    titleEl.addEventListener("pointerdown", function (e) {
        if (e.target && e.target.classList && e.target.classList.contains("ade-collapse-btn")) { return; }
        var rect = node.getBoundingClientRect();
        dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
        e.preventDefault();
    });
    window.addEventListener("pointermove", function (e) {
        if (!dragState) { return; }
        var maxLeft = document.documentElement.clientWidth - node.offsetWidth;
        var maxTop = document.documentElement.clientHeight - node.offsetHeight;
        var left = Math.max(0, Math.min(maxLeft, e.clientX - dragState.dx));
        var top = Math.max(0, Math.min(maxTop, e.clientY - dragState.dy));
        node.style.left = left + "px";
        node.style.top = top + "px";
        node.style.right = "auto";
    });
    window.addEventListener("pointerup", function () {
        if (!dragState) { return; }
        dragState = null;
        try {
            localStorage.setItem(POS_KEY, JSON.stringify({
                left: parseInt(node.style.left, 10) || 0,
                top: parseInt(node.style.top, 10) || 0
            }));
        } catch (e) {}
    });
    node.querySelector(".ade-collapse-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        node.classList.toggle("ade-collapsed");
        try { localStorage.setItem(COLLAPSED_KEY, node.classList.contains("ade-collapsed") ? "1" : "0"); } catch (err) {}
    });

    var rows = {};
    // Must list EVERY key the status loop reports. The four 2026-08-29 captures were added to
    // that loop without rows here, so `rows[key]` came back undefined and the interval threw
    // once a second -- silently freezing every indicator, not just the new ones.
    ["unitDataManager", "treasureDataManager", "petDataManager", "castleDataManager",
     "heroUpgradeManager", "maxWave", "questDataManager", "rebirthMedalManager",
     "spiritLandDataManager", "buffManager", "rankingDataManager", "ownRank",
     "medal", "rebirthSetup", "profileFrames", "runeDataManager"].forEach(function (key) {
        // runeDataManager added 2026-11-10: the Runes row (2026-11-09) was missing here, so it never ticked even
        // when the runes were captured and exported
        rows[key] = node.querySelector('[data-key="' + key + '"]');
    });
    var exportBtn = node.querySelector(".ade-btn");
    exportBtn.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    exportBtn.addEventListener("click", function () { dumpJson(); });

    var timer = setInterval(function () {
        if (efPluginOff(PLUGIN_ID)) { return; }
        var captured = {
            unitDataManager: !!state.unitDataManager,
            treasureDataManager: !!state.treasureDataManager,
            petDataManager: !!state.petDataManager,
            castleDataManager: !!state.castleDataManager,
            heroUpgradeManager: !!state.heroUpgradeManager,
            maxWave: state.maxWave != null,
            questDataManager: !!state.questDataManager,
            rebirthMedalManager: !!state.rebirthMedalManager,
            spiritLandDataManager: !!state.spiritLandDataManager,
            buffManager: !!state.buffManager,
            rankingDataManager: !!state.rankingDataManager,
            ownRank: !!(state.ownRank || state.rankingDataManager),
            medal: state.medal != null,
            rebirthSetup: !!(state.reviveTeamDataManager && state.reviveTeamDataManager.loaded),
            profileFrames: !!state.profileDeco,
            runeDataManager: !!(state.runeDataManager || state.runesFromResponse)
        };
        Object.keys(captured).forEach(function (key) {
            var row = rows[key];
            if (!row) { return; }   // a reported key with no row must not kill the updater
            var done = captured[key];
            row.classList.toggle("done", done);
            // A tick reads as "captured" at a glance in a way a lowercase v never did; the hollow
            // circle stays visibly empty rather than looking like another letter.
            row.querySelector(".ade-ic").textContent = done ? "\u2714" : "\u25CB";
        });
    }, 1000);

    return {
        detach: function () {
            clearInterval(timer);
            node.remove();
            style.remove();
        }
    };
}

export default {
    id: "account-fetcher",
    handleKey: "__EF_ACCOUNT_FETCHER_HANDLE__",

    setup(runtime) {
        var log = (runtime && runtime.logger) ? runtime.logger : console;
        var hooks = runtime && runtime.hooks;

        var state = {
            unitDataManager: null,
            treasureDataManager: null,
            petDataManager: null,
            castleDataManager: null,
            heroUpgradeManager: null,
            questDataManager: null,
            rebirthMedalManager: null,
            reviveTeamDataManager: null,
            reviveTreasureDataManager: null,
            spiritLandDataManager: null,
            buffManager: null,
            rankingDataManager: null,
            ownRank: null,
            maxWave: null,
            medal: null,
            accuMedal: null,
            tribe: null,
            rebirthCount: null,
            foreignMaxWaveSeen: false,
            profileDeco: null   // {state, seenAt, source}: the last /profileDeco/ response's body.state (see findProfileDecoState)
        };

        var unsubscribers = [];
        if (hooks && typeof hooks.onJsonParse === "function") {
            unsubscribers.push(hooks.onJsonParse(function (parsed) {
                // Unchecked in Config -> fully idle (RULE #1; 2026-09-27, plugin-perf-monitor showed this hook
                // walking every parsed response while switched off - 0.33 ms/s, 7 ms peaks). The capture
                // hooks below stay live: they only keep references to game managers created at boot, so
                // re-checking the plugin later still finds them.
                if (efPluginOff("account-fetcher")) { return; }  // setup()'s own literal - PLUGIN_ID lives in installOverlay()
                try {
                    var out = {
                        maxWave: state.maxWave, medal: state.medal, accuMedal: state.accuMedal,
                        tribe: state.tribe, rebirthCount: state.rebirthCount,
                        foreignMaxWaveSeen: state.foreignMaxWaveSeen
                    };
                    scanForMaxWave(parsed, 0, out);
                    if (out.maxWave != null && out.maxWave !== state.maxWave) {
                        state.maxWave = out.maxWave;
                    }
                    if (out.medal != null) { state.medal = out.medal; }
                    if (out.accuMedal != null) { state.accuMedal = out.accuMedal; }
                    if (out.tribe != null) { state.tribe = out.tribe; }
                    if (out.rebirthCount != null) { state.rebirthCount = out.rebirthCount; }
                    if (out.foreignMaxWaveSeen) { state.foreignMaxWaveSeen = true; }
                    // The explicit `userRank` object outranks the heuristic above whenever it
                    // appears -- it is the game's own statement of which row is yours.
                    var mine = state.ownRank || {};
                    scanForUserRank(parsed, 0, mine);
                    if (mine.maxWave != null) {
                        state.ownRank = mine;
                        state.maxWave = mine.maxWave;
                    }
                    // NEW 2026-10-15: the game's own /profileDeco/getState (or save) response, decrypted -> the object
                    // ProfileDecoManager.state holds. Two property reads per parse.
                    var deco = findProfileDecoState(parsed);
                    if (deco) { state.profileDeco = { state: deco, seenAt: new Date().toISOString(), source: "JSON.parse" }; }
                    // NEW 2026-11-10: runes from the game's own /rune/getAll answer (backup for a missed RuneDataManager)
                    var rg = findRuneGetAll(parsed);
                    if (rg) { state.runesFromResponse = rg; }
                } catch (e) {}
            }));
        }
        // NEW 2026-10-15: the same response when the server does not encrypt responses -- the client then reads it with
        // Response.json(), which never passes the page's JSON.parse. Observe-only, filtered to the game's own two
        // /profileDeco/ calls (getState, save).
        var network = runtime && runtime.network;
        if (network && typeof network.onJsonResponse === "function") {
            // NEW 2026-11-10: the /rune/getAll answer when read with Response.json() (backup for a missed RuneDataManager)
            unsubscribers.push(gatedSubscription("account-fetcher", function () {
                return network.onJsonResponse({ urlIncludes: "/rune/" }, async function (event) {
                    if (efPluginOff("account-fetcher")) { return; }
                    var body = null;
                    try { body = await event.readJson(); } catch (e) { return; }
                    var rg = findRuneGetAll(body);
                    if (rg) { state.runesFromResponse = rg; }
                });
            }));
            unsubscribers.push(gatedSubscription("account-fetcher", function () {
                return network.onJsonResponse({ urlIncludes: "/profileDeco/" }, async function (event) {
                    if (efPluginOff("account-fetcher")) { return; }
                    var body = null;
                    try { body = await event.readJson(); } catch (e) { return; }
                    var deco = findProfileDecoState(body);
                    if (deco) { state.profileDeco = { state: deco, seenAt: new Date().toISOString(), source: "response" }; }
                });
            }));
        }
        if (hooks && typeof hooks.onObjectWithProperties === "function") {
            // Watch keys are the instance's OWN properties: `sources` (a Map of registered buff sources) and
            // `_version` (the cache-busting counter). `getGameplayTotal` lives on the prototype, so it is
            // checked in the duck-type below rather than watched for here.
            unsubscribers.push(hooks.onObjectWithProperties(["myRankList", "selectedIndex"], function (candidate) {
                if (isRankingDataManager(candidate)) {
                    state.rankingDataManager = candidate;
                    log.info("account-fetcher", "captured RankingDataManager (own leaderboard row)");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["sources", "_version"], function (candidate) {
                if (isBuffManager(candidate)) {
                    state.buffManager = candidate;
                    log.info("account-fetcher", "captured BuffManager (gameplay totals available)");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["heroPresets", "ownedUnitList", "objBookList"], function (candidate) {
                if (isUnitDataManager(candidate)) {
                    state.unitDataManager = candidate;
                    log.info("account-fetcher", "captured UnitDataManager (" + candidate.ownedUnitList.length + " owned hero kinds, " + candidate.list.length + " deployed)");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["runes", "slots"], function (candidate) {
                if (isRuneDataManager(candidate)) {
                    state.runeDataManager = candidate;
                    log.info("account-fetcher", "captured RuneDataManager (" + candidate.runes.size + " owned runes)");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["bookList", "kindNumMap", "equipedKindNums"], function (candidate) {
                if (isTreasureDataManager(candidate)) {
                    state.treasureDataManager = candidate;
                    log.info("account-fetcher", "captured TreasureDataManager (" + (candidate.ownedList || []).length + " owned relics)");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["representPet", "revivePet", "bookMap"], function (candidate) {
                if (isPetDataManager(candidate)) {
                    state.petDataManager = candidate;
                    log.info("account-fetcher", "captured PetDataManager (" + candidate.list.length + " known pets)");
                }
            }));
            // NEW: castle + max-level cap. "bookList" collides in name with TreasureDataManager's own
            // watch key, which is fine — onObjectWithProperties fires the SAME candidate at every
            // matching listener, and each listener's own duck-type check (isCastleDataManager vs
            // isTreasureDataManager) rejects the other's object, same pattern already relied on above.
            unsubscribers.push(hooks.onObjectWithProperties(["castleVO", "bookList", "specialBookList"], function (candidate) {
                if (isCastleDataManager(candidate)) {
                    state.castleDataManager = candidate;
                    log.info("account-fetcher", "captured CastleDataManager (gold lvl " + candidate.castleLevel + ", medal lvl " + candidate.castleEnhance + ")");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["acc"], function (candidate) {
                if (isHeroUpgradeManager(candidate)) {
                    state.heroUpgradeManager = candidate;
                    var cap = null;
                    try { cap = candidate.getMaxLevel(5, 0); } catch (e) {}
                    log.info("account-fetcher", "captured HeroUpgradeManager (live castle max-level cap = " + cap + ")");
                }
            }));
            // NEW: idle gold income (goldPerSec) — the other half of "how long would it take to
            // afford leveling gold level to its cap", alongside the goldCostAcc curve above.
            unsubscribers.push(hooks.onObjectWithProperties(["goldPerSec", "list"], function (candidate) {
                if (isQuestDataManager(candidate)) {
                    state.questDataManager = candidate;
                    log.info("account-fetcher", "captured QuestDataManager (goldPerSec = " + candidate.goldPerSec + ")");
                }
            }));
            // NEW: answers 40-open-questions.md #18 - which rebirth-medal payout path (table vs
            // formula) is live for this account/channel. See isRebirthMedalManager's own header for
            // why this needs a hook rather than a direct window global read.
            unsubscribers.push(hooks.onObjectWithProperties(["medals", "segments"], function (candidate) {
                if (isRebirthMedalManager(candidate)) {
                    state.rebirthMedalManager = candidate;
                    var useFormula = null;
                    try { useFormula = candidate.useFormula; } catch (e) {}
                    log.info("account-fetcher", "captured RebirthMedalManager (useFormula = " + useFormula + ")");
                }
            }));
            // NEW 2026-10-04: the rebirth team / rebirth relics (see buildRebirthSetupExport). Both managers are created
            // on first use (getInstance), so these fire whenever the game first touches them.
            unsubscribers.push(hooks.onObjectWithProperties(["kindNums", "trans", "loaded"], function (candidate) {
                if (isReviveTeamDataManager(candidate)) {
                    state.reviveTeamDataManager = candidate;
                    log.info("account-fetcher", "captured ReviveTeamDataManager");
                }
            }));
            unsubscribers.push(hooks.onObjectWithProperties(["kindNums", "loaded"], function (candidate) {
                if (isReviveTreasureDataManager(candidate)) {
                    state.reviveTreasureDataManager = candidate;
                    log.info("account-fetcher", "captured ReviveTreasureDataManager");
                }
            }));
            // NEW: Spirit Highlands favorites list - "which pets are you actively farming
            // fragments for" (see isSpiritLandDataManager's own comment).
            unsubscribers.push(hooks.onObjectWithProperties(["favoritePets", "bookList", "ticket"], function (candidate) {
                if (isSpiritLandDataManager(candidate)) {
                    state.spiritLandDataManager = candidate;
                    log.info("account-fetcher", "captured SpiritLandDataManager (" + candidate.favoritePets.length + " favorited pets)");
                }
            }));
        }

        async function buildExport() {
            var localeData = await loadLocaleData();
            if (!localeData) {
                log.warn("account-fetcher", "locale-en.json not reachable — export will only have raw (likely non-English) names");
            }
            var petPoint = null;
            try {
                if (state.petDataManager && typeof state.petDataManager.getPetPoint === "function") {
                    petPoint = Number(state.petDataManager.getPetPoint());
                }
            } catch (e) {}
            var takenAt = new Date().toISOString();
            return {
                __ef_account_fetcher__: 1,
                takenAt: takenAt,
                // Capture date + game version travel with every export (EF2 DATA files exports by both).
                capturedAt: takenAt,
                gameVersion: gameVersion(),
                localeResolved: !!localeData,
                heroes: buildHeroesExport(state.unitDataManager, localeData),
                deployedHeroes: buildDeployedHeroesExport(state.unitDataManager, localeData),
                relics: buildRelicsExport(state.treasureDataManager, localeData),
                presets: {
                    hero: buildHeroPresetsExport(state.unitDataManager, localeData),
                    relic: buildRelicPresetsExport(state.treasureDataManager, localeData)
                },
                pets: buildPetsExport(state.petDataManager, localeData),
                petPoint: petPoint,
                castle: buildCastleExport(state.castleDataManager),
                caps: buildCapsExport(state.heroUpgradeManager, state.unitDataManager),
                runes: buildRunesExport(state.runeDataManager || state.runesFromResponse),
                // NEW 2026-11-10: where the runes came from (the game's rune data, or its /rune/getAll answer as a backup)
                runesSource: state.runeDataManager ? "RuneDataManager" : (state.runesFromResponse ? "rune/getAll answer" : null),
                // NEW 2026-11-09 — raid pet, ascend points per unit line, raid barracks (raid planning).
                raid: buildRaidExport(state.petDataManager, state.unitDataManager, null),
                goldPerSec: state.questDataManager && typeof state.questDataManager.goldPerSec === "number"
                    ? state.questDataManager.goldPerSec : null,
                favoritePets: buildFavoritePetsExport(state.spiritLandDataManager),
                maxWave: state.maxWave,
                // NEW 2026-08-29 — everything the wave calculator previously made the user type.
                gameplayTotals: buildGameplayTotalsExport(state.buffManager),
                // NEW 2026-10-15 (live 1.15.82) — profile-frame PlusLv (already inside gameplayTotals.pluslv) + the frames.
                profileFrames: buildProfileFramesExport(state),
                // NEW 2026-10-04 — the rebirth screen's team / relics / Guild War and the game's own medal payout.
                rebirthSetup: buildRebirthSetupExport(state),
                castleAbilities: buildCastleAbilitiesExport(state.castleDataManager),
                medal: state.medal,
                accuMedal: state.accuMedal,
                // Your own leaderboard row: the authoritative max wave, plus accumulated medals.
                ownRank: buildOwnRankExport(state.rankingDataManager) || state.ownRank || null,
                tribe: state.tribe,
                rebirthCount: state.rebirthCount,
                // True when a payload carrying someone ELSE's maxWave was seen (a leaderboard or
                // guild roster). Recorded so a reader knows the scan had foreign rows to reject,
                // rather than assuming it never met any.
                foreignMaxWaveSeen: state.foreignMaxWaveSeen
            };
        }

        // The runtime sets appBundleVersion from game-manifest.json = the installed updateBundle version.
        function gameVersion() {
            var v = String(window.appBundleVersion || "");
            return /^\d+\.\d+\.\d+$/.test(v) && v !== "0.0.0" ? v : "unknown";
        }

        async function dumpJson(filename) {
            var data = await buildExport();
            // The name stays `ef2-account-<ms>.json` (gameVersion is inside the file): NORMAL ENGINE's
            // push_gameplay.rs finds the newest export by parsing exactly that name.
            var name = filename || ("ef2-account-" + Date.parse(data.takenAt) + ".json");
            downloadText(JSON.stringify(data, null, 2), name, "application/json");
            // caps.goldCostAcc can be thousands of entries — summarized here (length only), not
            // dumped in full, so this log line stays readable; the full array is still in the file.
            var capsSummary = data.caps ? Object.assign({}, data.caps, {
                goldCostAcc: data.caps.goldCostAcc ? ("[" + data.caps.goldCostAcc.length + " entries]") : null
            }) : null;
            log.info("account-fetcher", "exported account data ("
                + (data.heroes ? data.heroes.length : 0) + " heroes, "
                + (data.relics ? data.relics.length : 0) + " relics, "
                + (data.pets ? data.pets.length : 0) + " pets, castle=" + JSON.stringify(data.castle)
                + ", caps=" + JSON.stringify(capsSummary) + ", goldPerSec=" + data.goldPerSec
                + ", favoritePets=" + (data.favoritePets ? JSON.stringify(data.favoritePets.favoritePets) : null)
                + ", locale resolved=" + data.localeResolved + ") to " + name);
            return data;
        }

        window.__EF_ACCOUNT_FETCHER__ = {
            state: state,
            dumpJson: dumpJson,
            debug: function () {
                console.log("[account-fetcher]",
                    "\n  unitDataManager:", !!state.unitDataManager,
                    "\n  treasureDataManager:", !!state.treasureDataManager,
                    "\n  petDataManager:", !!state.petDataManager,
                    "\n  castleDataManager:", !!state.castleDataManager,
                    "\n  heroUpgradeManager:", !!state.heroUpgradeManager,
                    "\n  maxWave:", state.maxWave,
                    "\n  questDataManager:", !!state.questDataManager,
                    state.questDataManager ? " (goldPerSec=" + state.questDataManager.goldPerSec + ")" : "",
                    "\n  rebirthMedalManager:", !!state.rebirthMedalManager,
                    state.rebirthMedalManager ? " (useFormula=" + state.rebirthMedalManager.useFormula + ")" : "",
                    "\n  spiritLandDataManager:", !!state.spiritLandDataManager,
                    state.spiritLandDataManager ? " (favoritePets=" + JSON.stringify(state.spiritLandDataManager.favoritePets) + ")" : "");
                return state;
            },
            // NEW: answers 40-open-questions.md #18 directly. true = the formula path
            // (HERO_REBIRTH_MEDAL_SEGMENT) is live; false = the table path (HERO_REBIRTH_MEDAL_TIER);
            // null = RebirthMedalManager not captured yet (open the game a moment - it backs the
            // always-visible MPM HUD widget, so this should populate quickly without visiting any
            // specific screen).
            getRebirthMedalUseFormula: function () {
                if (!state.rebirthMedalManager) { return null; }
                try { return !!state.rebirthMedalManager.useFormula; } catch (e) { return null; }
            }
        };

        var overlay = installOverlay(state, dumpJson);

        log.info("account-fetcher", "installed (read-only). Open the Hero/Relic/Pet/Castle/Quest screens to populate captures (max-level cap + gold-cost curve capture automatically once any hero-level UI has loaded HeroUpgradeManager); use __EF_ACCOUNT_FETCHER__.dumpJson() or the panel button to export.");

        return {
            detach() {
                unsubscribers.forEach(function (fn) { try { if (typeof fn === "function") { fn(); } } catch (e) {} });
                overlay.detach();
                delete window.__EF_ACCOUNT_FETCHER__;
            }
        };
    }
};
