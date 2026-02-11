import { logger } from "@vendetta";
import { findByName } from "@vendetta/metro";

// Reference to the original GIFFavButton component for cleanup
let origType: Function | null = null;
let memoWrapper: any = null;

/**
 * FavouriteAnything - Port of the Equicord plugin for Revenge (Discord Mobile)
 * By @TheUnrealZaka
 *
 * Discord Mobile's GIFFavButton component only renders the favourite star
 * for media items with `isGIFV: true`. This plugin intercepts the component
 * and forces that flag on ALL media (images, videos), filling in any missing
 * fields that GIFFavButton needs to function properly.
 */

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
        patched.embedProviderName = "Discord";
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

        logger.log("[FavouriteAnything] Loaded! ⭐ Favourite button enabled for all media.");
    },
    onUnload: () => {
        // Restore original component
        if (memoWrapper && origType) {
            memoWrapper.type = origType;
            origType = null;
            memoWrapper = null;
            logger.log("[FavouriteAnything] Unloaded. Original GIFFavButton restored.");
        }
    },
};