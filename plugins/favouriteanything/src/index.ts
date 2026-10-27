// FavouriteAnything - by @TheUnrealZaka
// Ported from the Equicord desktop plugin (nin0dev & davri)
// Patches GIFFavButton so the star shows on all media, not just GIFs.

/*!
 * Copyright (c) 2026 Zakaria Hamdaoui
 * Licensed under the MIT License. See the LICENSE file in the project root.
 * SPDX-License-Identifier: MIT
 */

import { logger } from "@vendetta";
import { find, findByProps } from "@vendetta/metro";
import { constants, React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";

const TAG = "[FavouriteAnything]";

const SIGNED_RE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-[12]\.discordapp\.net)\/(?:attachments|ephemeral-attachments|external)\//;
const ATTACHMENT_RE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/(?:attachments|ephemeral-attachments)\//;
const VIDEO_RE = /\.(?:mp4|webm|mov|m4v|avi|mkv|flv|wmv|gifv)$/i;
const THUMB_RE = /[?&]format=(?:png|jpe?g|webp)(?:&|$)/i;
const SIGNATURE_RE = /^(?:ex|is|hm)=/;
const PARAM_RE = /^[A-Za-z_]\w*=/;
const CDN = "cdn.discordapp.com";
const MEDIA = "media.discordapp.net";

const EXPIRY_MARGIN_MS = 3600000;
const BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 50;
const COOLDOWN_MS = 300000;
const MAX_QUEUED = 500;
const REFRESH_ENDPOINT = constants?.Endpoints?.ATTACHMENTS_REFRESH_URLS ?? "/attachments/refresh-urls";

const FORMAT_NONE = 0;
const FORMAT_IMAGE = 1;
const FORMAT_VIDEO = 2;

const stats = {
    buttonRenders: 0, buttonRewritten: 0,
    renewed: 0, renewFailed: 0, requests: 0,
    savesFixed: 0, itemsFixed: 0,
};
const patchState = { button: "pending", save: "pending", picker: "pending" };

const unpatches = [];
const listeners = new Set();
const renewed = new Map();
const cooldown = new Map();
const queue = new Set();
let queuedTotal = 0;
let flushTimer = null;
let flushing = false;
let version = 0;
let retryTimer = null;
let stopped = false;
let restApi;
let mapped = new WeakMap();

function split(url) {
    const h = url.indexOf("#");
    const hash = h < 0 ? "" : url.slice(h);
    const rest = h < 0 ? url : url.slice(0, h);
    const q = rest.indexOf("?");
    return q < 0 ? [rest, "", hash] : [rest.slice(0, q), rest.slice(q + 1), hash];
}

const baseOf = u => split(u)[0];
const paramsOf = u => split(u)[1].split("&").filter(Boolean);
const extrasOf = u => paramsOf(u).filter(p => PARAM_RE.test(p) && !SIGNATURE_RE.test(p));
const signatureOf = u => paramsOf(u).filter(p => SIGNATURE_RE.test(p));
const keyOf = p => p.slice(0, p.indexOf("="));

function build(base, params, hash) {
    const seen = new Set();
    const unique = params.filter(p => { const k = keyOf(p); if (seen.has(k)) return false; seen.add(k); return true; });
    return base + (unique.length ? "?" + unique.join("&") : "") + (hash || "");
}

const isSigned = u => typeof u === "string" && SIGNED_RE.test(u);
const isAttachment = u => typeof u === "string" && ATTACHMENT_RE.test(u);
const isVideoFile = u => typeof u === "string" && VIDEO_RE.test(baseOf(u));
const isVideoSrc = u => isVideoFile(u) && !THUMB_RE.test(u);

function expiryOf(u) {
    const m = /[?&]ex=([0-9a-f]+)/i.exec(u);
    return m ? parseInt(m[1], 16) * 1000 : 0;
}

const isStale = u => expiryOf(u) - EXPIRY_MARGIN_MS < Date.now();

function getRest() {
    if (restApi === undefined) {
        try { restApi = findByProps("getAPIBaseURL", "post") ?? null; } catch { restApi = null; }
        if (!restApi) logger.warn(TAG, "REST API module not found; expired URLs can't be renewed.");
    }
    return restApi;
}

function notify() {
    version++;
    for (const f of listeners) { try { f(); } catch { listeners.delete(f); } }
}

function enqueue(key) {
    if (queue.has(key) || queuedTotal >= MAX_QUEUED) return;
    if ((cooldown.get(key) ?? 0) > Date.now()) return;
    queue.add(key);
    queuedTotal++;
    if (!flushTimer && !flushing) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

function failBatch(chunk) {
    stats.renewFailed += chunk.length;
    for (const k of chunk) cooldown.set(k, Date.now() + COOLDOWN_MS);
}

async function flush() {
    flushTimer = null;
    if (flushing || stopped) return;
    flushing = true;
    try {
        const api = getRest();
        while (queue.size && !stopped) {
            const chunk = Array.from(queue).slice(0, BATCH_SIZE);
            for (const k of chunk) queue.delete(k);
            if (!api) { failBatch(chunk); continue; }
            try {
                stats.requests++;
                const res = await api.post({ url: REFRESH_ENDPOINT, body: { attachment_urls: chunk }, retries: 3 });
                for (const r of res?.body?.refreshed_urls ?? []) {
                    if (r?.original && r?.refreshed) renewed.set(r.original, r.refreshed);
                }
                const missed = [];
                for (const k of chunk) {
                    const got = renewed.get(k);
                    if (got && !isStale(got)) stats.renewed++;
                    else missed.push(k);
                }
                if (missed.length) failBatch(missed);
            } catch (e) {
                failBatch(chunk);
                logger.warn(TAG, "refresh-urls failed", e);
            }
        }
    } finally {
        flushing = false;
        if (!stopped) notify();
    }
}

function resolveUrl(url) {
    if (!isSigned(url) || !isStale(url)) return url;
    const key = baseOf(url);
    const hit = renewed.get(key);
    if (hit && !isStale(hit)) {
        const [base, query] = split(hit);
        const fresh = query.split("&").filter(Boolean);
        return build(base, [...fresh, ...extrasOf(url)], split(url)[2]);
    }
    enqueue(key);
    return url;
}

function fixFormat(src, format) {
    if (isVideoSrc(src)) return FORMAT_VIDEO;
    if (format === FORMAT_VIDEO && isSigned(src)) return FORMAT_IMAGE;
    return format;
}

function videoThumbnail(src) {
    const [base, , hash] = split(src);
    return build(base.replace(CDN, MEDIA), [...signatureOf(src), ...extrasOf(src), "format=png"], hash);
}

function fixItem(item) {
    if (!item || typeof item !== "object") return item;
    const url = resolveUrl(item.url);
    let src = resolveUrl(item.src);
    if (isAttachment(src) && isVideoSrc(src)) src = videoThumbnail(src);
    const format = item.format === FORMAT_NONE ? FORMAT_NONE : fixFormat(src, item.format);
    if (url === item.url && src === item.src && format === item.format) return item;
    stats.itemsFixed++;
    return { ...item, url, src, format };
}

function mapFavorites(favs) {
    const hit = mapped.get(favs);
    if (hit && hit.version === version) return hit.out;
    let changed = false;
    const out = favs.map(i => { const n = fixItem(i); if (n !== i) changed = true; return n; });
    const result = changed ? out : favs;
    mapped.set(favs, { version, out: result });
    return result;
}

function normalizeSave(data) {
    const { url, src, format } = data;
    if (format === FORMAT_NONE) return data;
    if (isAttachment(url) && isVideoSrc(url) && !isVideoSrc(src)) {
        const [base, , hash] = split(url);
        const next = build(base, signatureOf(url), hash);
        return { ...data, src: next, format: FORMAT_VIDEO };
    }
    const fixed = fixFormat(src, format);
    return fixed === format ? data : { ...data, format: fixed };
}

const nameOf = fn => fn?.displayName ?? fn?.name;

function locateButton(mod) {
    try {
        for (const holder of [mod?.default, mod]) {
            if (holder && typeof holder.type === "function" && nameOf(holder.type) === "GIFFavButton") return [holder, "type"];
        }
        if (typeof mod?.default === "function" && nameOf(mod.default) === "GIFFavButton") return [mod, "default"];
    } catch {
        return null;
    }
    return null;
}

function rewriteButtonProps(args) {
    stats.buttonRenders++;
    const props = args[0];
    const s = props?.source;
    if (!s || typeof s !== "object" || s.isGIFV) return;
    stats.buttonRewritten++;
    return [{
        ...props,
        source: {
            ...s,
            isGIFV: true,
            embedURI: s.embedURI || s.sourceURI || s.uri,
            videoURI: s.videoURI || s.uri,
            embedProviderName: s.embedProviderName || "",
        },
    }, ...args.slice(1)];
}

function patchButton() {
    const mod = find(m => !!locateButton(m));
    const target = mod && locateButton(mod);
    if (!target) return false;
    unpatches.push(before(target[1], target[0], rewriteButtonProps));
    return true;
}

function patchSave() {
    const mod = findByProps("addFavoriteGIF");
    if (!mod || typeof mod.addFavoriteGIF !== "function") return false;
    unpatches.push(before("addFavoriteGIF", mod, args => {
        const data = args[0];
        if (!data || typeof data !== "object") return;
        const next = normalizeSave(data);
        if (next === data) return;
        stats.savesFixed++;
        return [next, ...args.slice(1)];
    }));
    return true;
}

function useRerender() {
    const [, force] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => { listeners.delete(force); };
    }, []);
}

function patchPicker() {
    const mod = findByProps("useFavoriteGIFsMobile");
    if (!mod || typeof mod.useFavoriteGIFsMobile !== "function") return false;
    unpatches.push(after("useFavoriteGIFsMobile", mod, (_args, res) => {
        useRerender();
        const favs = res?.favorites;
        const out = Array.isArray(favs) ? mapFavorites(favs) : favs;
        return React.useMemo(() => (out === favs ? res : { ...res, favorites: out }), [res, out]);
    }));
    return true;
}

function apply(name, fn) {
    try {
        patchState[name] = fn() ? "applied" : "missing";
    } catch (e) {
        patchState[name] = "error: " + String(e?.message ?? e);
        logger.warn(TAG, name, "patch failed", e);
    }
    return patchState[name] === "applied";
}

export default {
    onLoad() {
        stopped = false;
        apply("save", patchSave);
        apply("picker", patchPicker);

        let tries = 0;
        const tryButton = () => {
            retryTimer = null;
            if (stopped || apply("button", patchButton)) return;
            if (++tries < 10) retryTimer = setTimeout(tryButton, 1000);
            else logger.warn(TAG, "GIFFavButton not found; no star on images/videos.");
        };
        tryButton();

        globalThis.__FavouriteAnything = {
            status: () => JSON.stringify({
                patches: patchState, stats,
                cached: renewed.size, queued: queue.size, coolingDown: cooldown.size,
            }),
        };
    },

    onUnload() {
        stopped = true;
        clearTimeout(retryTimer); retryTimer = null;
        clearTimeout(flushTimer); flushTimer = null;
        for (const un of unpatches.splice(0)) { try { un(); } catch { continue; } }
        listeners.clear(); renewed.clear(); cooldown.clear(); queue.clear();
        queuedTotal = 0; version = 0; restApi = undefined; mapped = new WeakMap();
        for (const k of Object.keys(patchState)) patchState[k] = "pending";
        for (const k of Object.keys(stats)) stats[k] = 0;
        delete globalThis.__FavouriteAnything;
    },
};
