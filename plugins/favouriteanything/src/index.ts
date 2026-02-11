import { logger } from "@vendetta";
import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";

// Cleanup references
let origType: Function | null = null;
let memoWrapper: any = null;
let unpatchAddFavorite: (() => void) | null = null;
let origUseFavoriteGIFsMobile: Function | null = null;
let favMobileModule: any = null;

/**
 * FavouriteAnything - Port of the Equicord plugin for Revenge (Discord Mobile)
 * By @TheUnrealZaka
 *
 * Three patches:
 * 1. GIFFavButton: Forces `isGIFV: true` so the star button renders for ALL media
 * 2. addFavoriteGIF (before): Fixes format field — images get format 1, videos get format 2
 * 3. useFavoriteGIFsMobile: Converts video src URLs to jpeg thumbnails for the
 *    mobile favourites picker (visual only, does not modify saved data)
 *
 * Format enum: 0 = NONE, 1 = IMAGE, 2 = VIDEO
 */

// Video extensions — anything NOT matching these is treated as an image
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".m4v", ".gifv"];

function isVideoUrl(url: string): boolean {
    if (!url) return false;
    try {
        const pathname = new URL(url).pathname.toLowerCase();
        return VIDEO_EXTENSIONS.some(ext => pathname.endsWith(ext));
    } catch {
        const lower = url.toLowerCase().split("?")[0].split("#")[0];
        return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
    }
}

/**
 * Convert a Discord video URL to a static jpeg thumbnail via the media proxy.
 * Converts cdn.discordapp.com → media.discordapp.net (which supports format conversion).
 * Used only for mobile rendering — saved data is NOT modified.
 */
function makeVideoThumbnail(url: string): string {
    if (!url) return url;
    try {
        const u = new URL(url);
        // cdn doesn't support ?format=, but media proxy does
        if (u.hostname === "cdn.discordapp.com") {
            u.hostname = "media.discordapp.net";
        }
        if (u.hostname.includes("media.discordapp.net") || u.hostname.includes("images-ext")) {
            u.searchParams.set("format", "jpeg");
            return u.toString();
        }
    } catch { /* keep original */ }
    return url;
}

function findGIFFavButton(): any {
    // findByName with false returns the module object (not just default export)
    // GIFFavButton isn't found by findByName due to being wrapped in React.memo,
    // so we do a manual scan of all modules
    const modules = (window as any).vendetta?.metro?.modules
        ?? (window as any).modules;

    if (!modules) return null;

    for (const id in modules) {
        try {
            const mod = modules[id]?.publicModule?.exports;
            if (!mod) continue;

            // Check default export (React.memo wrapper)
            const def = mod.default;
            if (def && def.$$typeof?.toString().includes("memo") && def.type) {
                const name = def.type.displayName || def.type.name;
                if (name === "GIFFavButton") {
                    return def;
                }
            }

            // Check direct export
            if (typeof mod === "function" && (mod.displayName === "GIFFavButton" || mod.name === "GIFFavButton")) {
                return mod;
            }
        } catch (e) {
            // Skip modules that throw on access
        }
    }

    return null;
}

function patchSource(source: any): any {
    // Already a GIFV, no patching needed
    if (source.isGIFV) return source;

    const patched = { ...source };

    // Force the GIFV flag so GIFFavButton renders
    patched.isGIFV = true;

    // Fill in required fields that GIFFavButton expects
    if (!patched.embedURI) {
        patched.embedURI = patched.sourceURI || patched.uri;
    }
    if (!patched.videoURI) {
        patched.videoURI = patched.uri;
    }
    if (!patched.embedProviderName) {
        patched.embedProviderName = "";
    }

    return patched;
}

export default {
    onLoad: () => {
        memoWrapper = findGIFFavButton();

        if (!memoWrapper) {
            logger.error("[FavouriteAnything] GIFFavButton not found! The module ID may have changed.");
            return;
        }

        // Save original for cleanup
        origType = memoWrapper.type;

        // Replace the inner component of the React.memo wrapper
        memoWrapper.type = function PatchedGIFFavButton(props: any) {
            const patchedProps = { ...props };

            if (patchedProps.source && !patchedProps.source.isGIFV) {
                patchedProps.source = patchSource(patchedProps.source);
            }

            return (origType as Function)(patchedProps);
        };

        // Preserve displayName for React DevTools
        (memoWrapper.type as any).displayName = "GIFFavButton";

        // Patch addFavoriteGIF to fix format and thumbnails
        // Uses `before` to modify args BEFORE the function executes
        // Inverted detection: if NOT a video URL → must be an image (handles extensionless URLs)
        const favModule = findByProps("addFavoriteGIF");
        if (favModule) {
            unpatchAddFavorite = before("addFavoriteGIF", favModule, (args: any[]) => {
                const data = args[0];
                if (data && typeof data === "object") {
                    const url = data.url || "";
                    const src = data.src || "";

                    if (isVideoUrl(url) || isVideoUrl(src)) {
                        // It's a video — keep format 2
                        data.format = 2;
                    } else {
                        // Not a video → image — fix format to 1
                        if (data.format === 2) {
                            data.format = 1;
                        }
                    }
                }
            });
            logger.log("[FavouriteAnything] addFavoriteGIF patched (before) for format correction.");
        } else {
            logger.warn("[FavouriteAnything] addFavoriteGIF module not found — format correction disabled.");
        }

        // Patch useFavoriteGIFsMobile to show jpeg thumbnails for videos
        // The mobile picker uses an Image component that can't render .mp4 files,
        // so we convert video src to ?format=jpeg via Discord's media proxy.
        // This is visual-only — the saved favourite data stays unchanged.
        const favMobileMod = findByProps("useFavoriteGIFsMobile");
        if (favMobileMod) {
            favMobileModule = favMobileMod;
            origUseFavoriteGIFsMobile = favMobileMod.useFavoriteGIFsMobile;

            favMobileMod.useFavoriteGIFsMobile = function (...args: any[]) {
                const result = (origUseFavoriteGIFsMobile as Function).apply(this, args);

                if (result && Array.isArray(result.favorites)) {
                    result.favorites = result.favorites.map((item: any) => {
                        if (!item) return item;
                        if (isVideoUrl(item.url) || isVideoUrl(item.src)) {
                            return { ...item, src: makeVideoThumbnail(item.src || item.url) };
                        }
                        return item;
                    });
                }

                return result;
            };

            logger.log("[FavouriteAnything] useFavoriteGIFsMobile patched for video thumbnails.");
        } else {
            logger.warn("[FavouriteAnything] useFavoriteGIFsMobile not found — video thumbnails may not show.");
        }

        logger.log("[FavouriteAnything] Loaded! ⭐ Favourite button enabled for all media.");
    },
    onUnload: () => {
        // Restore original component
        if (memoWrapper && origType) {
            memoWrapper.type = origType;
            origType = null;
            memoWrapper = null;
        }

        // Unpatch addFavoriteGIF
        if (unpatchAddFavorite) {
            unpatchAddFavorite();
            unpatchAddFavorite = null;
        }

        // Restore useFavoriteGIFsMobile
        if (favMobileModule && origUseFavoriteGIFsMobile) {
            favMobileModule.useFavoriteGIFsMobile = origUseFavoriteGIFsMobile;
            origUseFavoriteGIFsMobile = null;
            favMobileModule = null;
        }

        logger.log("[FavouriteAnything] Unloaded. All patches restored.");
    },
};