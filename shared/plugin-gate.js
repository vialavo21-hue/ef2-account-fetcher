/*
 * Canonical Config-gate helper — RULE #1: unchecked in the Config panel means the
 * plugin is FULLY inactive, not merely hidden.
 *
 * The runtime's Config checkbox only sets style="display:none" on the plugin's
 * [data-ef-plugin-overlay="<id>"] node. It does not unload the plugin or stop any
 * of its work. Every plugin therefore has to gate itself, and every active path
 * counts: rAF ticks, intervals, JSON.parse observers, wrapped game methods, and
 * network writes (the /__ef_debug_log__ POSTs especially).
 *
 * WHY UNSUBSCRIBING MATTERS, NOT JUST AN EARLY RETURN
 * ---------------------------------------------------
 * runtime.hooks.onObjectWithProperties is by far the most expensive hook in the
 * system. For each watched property name it installs a SETTER ON Object.prototype
 * (see plugin-api/property-detector.js). From then on every assignment of that
 * name — anywhere in the game, on any object, including Pixi's own — runs a JS
 * setter plus a defineProperty instead of a plain store, which also breaks the
 * hidden-class sharing V8 relies on. Watched names across this folder include
 * `data`, `list`, `menus`, `vo`, `list1`..`list4`, `presets`: some of the most
 * common property names there are.
 *
 * That cost lives in the SUBSCRIPTION, not in the callback. Returning early from
 * the callback leaves the whole tax in place. So a gated hook must actually call
 * its unsubscribe function when the plugin is unchecked, and re-subscribe when it
 * is checked again — which is what gatedSubscription() below does.
 *
 * Trade-off, by design: while unchecked, a plugin observes nothing, so objects the
 * game created during that time were never seen. After re-checking, a plugin whose
 * capture is one-shot may need the relevant screen reopened before it re-captures.
 * That is the intended meaning of "not active".
 *
 * USAGE
 * -----
 * ES module (plugin.js):
 *     import { gatedSubscription, createGate, isPluginOff } from "../shared/plugin-gate.js";
 *     const stop = gatedSubscription("my-plugin", () =>
 *         runtime.hooks.onObjectWithProperties(["blocks"], onCandidate));
 *     // ...and in detach(): stop();
 *
 * Classic script (overlay.js loaded via <script>):
 *     var off = (window.__EF_PLUGIN_GATE__ && window.__EF_PLUGIN_GATE__.isPluginOff) || function () { return false; };
 *     if (off("my-plugin")) { return; }   // at the top of each rAF tick / interval
 *
 * NETWORK SUBSCRIPTIONS GET A SECOND GATE INSIDE THE RUNTIME
 * ----------------------------------------------------------
 * A runtime.network.on*() subscription is also what makes networkProxy.js clone every matching
 * Response and await the handlers before the game gets its reply. The runtime's network bus
 * (plugin-api/networkBus.js) therefore tags each subscription with its owning plugin and skips it,
 * clone included, while that plugin is unchecked. The tag comes from currentSubscriber() below,
 * published for the duration of gatedSubscription()'s subscribe() callback, or from an explicit
 * `pluginId` in the subscription options for a plugin that does not use gatedSubscription.
 */

const GATE_ATTRIBUTE = "data-ef-plugin-overlay";
const REFRESH_MS = 250;

/*
 * isPluginOff() is called from the hottest code these plugins have — a wrapped
 * `execute()` runs once per live unit per frame — so it MUST NOT touch the DOM per
 * call. A single shared timer re-resolves every registered plugin's node and
 * caches the boolean; isPluginOff is then just a Map read.
 */
const gateState = new Map();   // pluginId -> { node, off }
let refreshTimer = 0;

function resolveOne(pluginId, entry) {
    if (!entry.node || !entry.node.isConnected) {
        entry.node = document.querySelector(`[${GATE_ATTRIBUTE}="${pluginId}"]`);
    }
    // No overlay node yet (plugin still starting up) -> treat as ON, so a plugin
    // never gates itself off merely because its panel has not been built.
    entry.off = !!entry.node && entry.node.style.display === "none";
}

// Every gate rides this one ticker. An earlier version gave each gatedSubscription its own
// setInterval, which meant ~100 timers across the folder all polling the same few booleans
// (auto-progression-scorer alone accounted for 41). One timer, one pass, then notify.
const gateWatchers = new Set();

function refreshAll() {
    for (const [pluginId, entry] of gateState) {
        try { resolveOne(pluginId, entry); } catch (error) { entry.off = false; }
    }
    for (const watcher of Array.from(gateWatchers)) {
        try { watcher(); } catch (error) { /* one bad gate must not stall the rest */ }
    }
}

function ensureRefreshTimer() {
    if (refreshTimer || typeof setInterval !== "function") {
        return;
    }
    refreshTimer = setInterval(refreshAll, REFRESH_MS);
    // 2026-11-07: the interval must not keep a Node process alive (the plugin test harness calls isPluginOff through the
    // plugins' own paths); a browser has no unref and ignores this.
    if (refreshTimer && typeof refreshTimer.unref === "function") { refreshTimer.unref(); }
}

/* True when the plugin is unchecked in the Config panel. O(1), no DOM access. */
export function isPluginOff(pluginId) {
    let entry = gateState.get(pluginId);
    if (!entry) {
        entry = { node: null, off: false };
        gateState.set(pluginId, entry);
        try { resolveOne(pluginId, entry); } catch (error) { entry.off = false; }
        ensureRefreshTimer();
    }
    return entry.off;
}

/*
 * Watch the checkbox and fire onEnable/onDisable on each transition. Calls
 * onEnable immediately if the plugin starts out checked. Returns a stop function.
 */
export function createGate(pluginId, { onEnable, onDisable } = {}) {
    let enabled = null;   // null = not yet decided, so the first read always fires
    let stopped = false;

    function evaluate() {
        if (stopped) {
            return;
        }
        const nowEnabled = !isPluginOff(pluginId);
        if (nowEnabled === enabled) {
            return;
        }
        enabled = nowEnabled;
        try {
            if (nowEnabled) {
                if (typeof onEnable === "function") onEnable();
            } else if (typeof onDisable === "function") {
                onDisable();
            }
        } catch (error) {
            console.warn(`[${pluginId}] gate transition failed:`, error);
        }
    }

    ensureRefreshTimer();
    evaluate();
    gateWatchers.add(evaluate);

    return function stopGate() {
        if (stopped) {
            return;
        }
        stopped = true;
        gateWatchers.delete(evaluate);
        if (enabled && typeof onDisable === "function") {
            try { onDisable(); } catch (error) { /* tearing down anyway */ }
        }
    };
}

/*
 * The plugin whose gatedSubscription() is currently running its subscribe() callback, or null.
 * Read synchronously by the runtime's network bus inside each runtime.network.on*() call, so a
 * subscription made through gatedSubscription is attributed to its plugin without the plugin
 * passing anything. The runtime cannot import this module (plugins/ and the runtime are served
 * separately), which is why it is also exported on window.__EF_PLUGIN_GATE__ at the bottom.
 */
let subscribingFor = null;

export function currentSubscriber() {
    return subscribingFor;
}

/*
 * Hold a runtime-hook subscription only while the plugin is checked.
 *
 * `subscribe` is called on enable and must return the hook's unsubscribe function
 * (which every runtime.hooks.* method already returns). On disable that function
 * is called, genuinely removing the Object.prototype setter / JSON.parse listener
 * rather than merely skipping work inside it.
 *
 * Returns a stop function that unsubscribes and stops watching the checkbox.
 */
export function gatedSubscription(pluginId, subscribe) {
    let unsubscribe = null;

    const stopGate = createGate(pluginId, {
        onEnable() {
            if (unsubscribe) {
                return;
            }
            // Published while subscribe() runs so the runtime's network bus can tag the
            // subscriptions it creates with this plugin's id (see currentSubscriber below).
            const previous = subscribingFor;
            subscribingFor = pluginId;
            let result;
            try {
                result = subscribe();
            } finally {
                subscribingFor = previous;
            }
            unsubscribe = typeof result === "function" ? result : null;
        },
        onDisable() {
            if (!unsubscribe) {
                return;
            }
            try { unsubscribe(); } catch (error) { console.warn(`[${pluginId}] unsubscribe failed:`, error); }
            unsubscribe = null;
        }
    });

    return function stop() {
        stopGate();
        if (unsubscribe) {
            try { unsubscribe(); } catch (error) { /* tearing down anyway */ }
            unsubscribe = null;
        }
    };
}

/*
 * setInterval that only runs its callback while the plugin is checked. The timer
 * itself is cheap to leave running; the point is that the work does not happen.
 * For anything expensive held by a SUBSCRIPTION, use gatedSubscription instead.
 */
export function gatedInterval(pluginId, callback, intervalMs) {
    const timer = setInterval(() => {
        if (isPluginOff(pluginId)) {
            return;
        }
        callback();
    }, intervalMs);
    return function stop() { clearInterval(timer); };
}

/*
 * requestAnimationFrame loop that keeps rescheduling while the plugin is
 * unchecked but does no work, so it resumes the moment it is re-checked.
 */
export function gatedAnimationFrame(pluginId, callback) {
    let running = true;
    let handle = 0;
    function tick() {
        if (!running) {
            return;
        }
        if (!isPluginOff(pluginId)) {
            try { callback(); } catch (error) { /* a bad frame must not kill the loop */ }
        }
        handle = requestAnimationFrame(tick);
    }
    handle = requestAnimationFrame(tick);
    return function stop() { running = false; cancelAnimationFrame(handle); };
}

// Classic (non-module) scripts such as overlay.js cannot import, so expose the
// same helpers on window. plugin.js importing this module is what installs them.
if (typeof window !== "undefined") {
    window.__EF_PLUGIN_GATE__ = {
        isPluginOff,
        currentSubscriber,
        createGate,
        gatedSubscription,
        gatedInterval,
        gatedAnimationFrame
    };
}
