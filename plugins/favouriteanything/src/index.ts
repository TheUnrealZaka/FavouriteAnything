import { logger } from "@vendetta";
import { findByProps } from "@vendetta/metro";
import { before } from "@vendetta/patcher";

// Cleanup references
let origType: Function | null = null;
let memoWrapper: any = null;
let unpatchAddFavorite: (() => void) | null = null;

/**
 * FavouriteAnything - Port of the Equicord plugin for Revenge (Discord Mobile)
 * By @TheUnrealZaka
 *
 * Discord Mobile's GIFFavButton component only renders the favourite star
 * for media items with `isGIFV: true`. This plugin intercepts the component
 * and forces that flag on ALL media (images, videos), filling in any missing
 * fields that GIFFavButton needs to function properly.
 *
 * It also patches `addFavoriteGIF` to fix the format field:
 * - Images are saved with format 1 (IMAGE) instead of 2 (VIDEO)
 * - Videos keep format 2 (VIDEO) with a static jpeg thumbnail for mobile
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
 * Generate a static jpeg thumbnail URL for a video using Discord's media proxy.
 * This is needed because the mobile favourites picker uses an Image component
 * which cannot render video files directly.
 */
function makeVideoThumbnail(url: string): string {
    if (!url) return url;
    try {
        const u = new URL(url);
        if (u.hostname.includes("media.discordapp.net") ||
            u.hostname.includes("cdn.discordapp.com") ||
            u.hostname.includes("images-ext")) {
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
                        // It's a video — keep format 2, add jpeg thumbnail for mobile
                        data.format = 2;
                        const thumb = makeVideoThumbnail(src || url);
                        if (thumb !== (src || url)) {
                            data.src = thumb;
                        }
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

        logger.log("[FavouriteAnything] Unloaded. All patches restored.");
    },
};