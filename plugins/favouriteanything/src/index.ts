// FavouriteAnything - by @TheUnrealZaka
// Ported from the Equicord desktop plugin (nin0dev & davri)
// Patches GIFFavButton so the star shows on all media, not just GIFs.
// Also fixes the format field when saving (images=1, videos=2)
// and converts video thumbnails to jpeg for the mobile favourites picker.

import { logger } from "@vendetta";
import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";

let origType: Function | null = null;
let memoWrapper: any = null;
let retryTimeout: ReturnType<typeof setTimeout> | null = null;
let unpatchAddFavorite: (() => void) | null = null;
let origUseFavoriteGIFsMobile: Function | null = null;
let favMobileModule: any = null;

const VIDEO_EXT = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v", ".gifv"];

function isVideo(url: string): boolean {
    if (!url) return false;
    try {
        return VIDEO_EXT.some(e => new URL(url).pathname.toLowerCase().endsWith(e));
    } catch {
        return VIDEO_EXT.some(e => url.toLowerCase().split("?")[0].endsWith(e));
    }
}

// cdn.discordapp.com doesn't support ?format=, media.discordapp.net does
function makeVideoThumbnail(url: string): string {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (u.hostname === "cdn.discordapp.com") u.hostname = "media.discordapp.net";
        if (u.hostname.includes("media.discordapp.net") || u.hostname.includes("images-ext")) {
            u.searchParams.set("format", "jpeg");
            return u.toString();
        }
    } catch {}
    return url;
}

function findGIFFavButton(): any {
    const modules = (window as any).vendetta?.metro?.modules ?? (window as any).modules;
    if (!modules) return null;

    for (const id in modules) {
        try {
            const mod = modules[id]?.publicModule?.exports;
            if (!mod) continue;
            const def = mod.default;
            if (def?.$$typeof?.toString().includes("memo") && def.type) {
                if (def.type.displayName === "GIFFavButton" || def.type.name === "GIFFavButton") return def;
            }
            if (typeof mod === "function" && (mod.displayName === "GIFFavButton" || mod.name === "GIFFavButton")) return mod;
        } catch {}
    }
    return null;
}

function patchSource(source: any): any {
    if (source.isGIFV) return source;
    return {
        ...source,
        isGIFV: true,
        embedURI: source.embedURI || source.sourceURI || source.uri,
        videoURI: source.videoURI || source.uri,
        embedProviderName: source.embedProviderName || "",
    };
}

function applyPatch() {
    memoWrapper = findGIFFavButton();
    if (!memoWrapper) return false;

    origType = memoWrapper.type;
    memoWrapper.type = function PatchedGIFFavButton(props: any) {
        const p = { ...props };
        if (p.source && !p.source.isGIFV) p.source = patchSource(p.source);
        return (origType as Function)(p);
    };
    (memoWrapper.type as any).displayName = "GIFFavButton";
    return true;
}

function patchAddFavorite() {
    const favModule = findByProps("addFavoriteGIF");
    if (!favModule) return;

    unpatchAddFavorite = before("addFavoriteGIF", favModule, (args: any[]) => {
        const data = args[0];
        if (!data || typeof data !== "object") return;
        const url = data.url || "";
        const src = data.src || "";

        if (isVideo(url) || isVideo(src)) {
            data.format = 2;
        } else if (data.format === 2) {
            data.format = 1;
        }
    });
}

function patchMobileFavorites() {
    const mod = findByProps("useFavoriteGIFsMobile");
    if (!mod) return;

    favMobileModule = mod;
    origUseFavoriteGIFsMobile = mod.useFavoriteGIFsMobile;

    mod.useFavoriteGIFsMobile = function (...args: any[]) {
        const result = (origUseFavoriteGIFsMobile as Function).apply(this, args);
        if (result?.favorites && Array.isArray(result.favorites)) {
            result.favorites = result.favorites.map((item: any) => {
                if (!item) return item;
                if (isVideo(item.url) || isVideo(item.src)) {
                    return { ...item, src: makeVideoThumbnail(item.src || item.url) };
                }
                return item;
            });
        }
        return result;
    };
}

export default {
    onLoad: () => {
        if (applyPatch()) {
            logger.log("[FavouriteAnything] Patched GIFFavButton.");
        } else {
            let retries = 0;
            const tryPatch = () => {
                if (applyPatch()) {
                    logger.log("[FavouriteAnything] Patched GIFFavButton (after retry).");
                    retryTimeout = null;
                } else if (retries++ < 50) {
                    retryTimeout = setTimeout(tryPatch, 300);
                } else {
                    logger.error("[FavouriteAnything] GIFFavButton not found after retries.");
                }
            };
            retryTimeout = setTimeout(tryPatch, 300);
        }

        patchAddFavorite();
        patchMobileFavorites();
    },
    onUnload: () => {
        if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
        if (memoWrapper && origType) {
            memoWrapper.type = origType;
            origType = null;
            memoWrapper = null;
        }
        if (unpatchAddFavorite) { unpatchAddFavorite(); unpatchAddFavorite = null; }
        if (favMobileModule && origUseFavoriteGIFsMobile) {
            favMobileModule.useFavoriteGIFsMobile = origUseFavoriteGIFsMobile;
            origUseFavoriteGIFsMobile = null;
            favMobileModule = null;
        }
    },
};
