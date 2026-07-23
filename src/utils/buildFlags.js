/**
 * Build-time flags injected via Vite env vars.
 *
 * MAS builds set `VITE_MV_APPSTORE=1` before running `vite build`.
 * Used to gate Sparkle UI, show IAP paywalls, and adjust copy.
 */
export const IS_APPSTORE_BUILD = import.meta.env.VITE_MV_APPSTORE === '1';

/** Product identifier for the backups in-app purchase (must match App Store Connect). */
export const IAP_PRODUCT_BACKUPS = 'com.mailvault.app.backups';
