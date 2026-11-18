// The free plan's cap on saved views, for both apps (desktop's stores/viewStore.js re-exports it;
// the phone's Views page reads it here, its engine refusing past it with PREMIUM_REQUIRED): pure,
// no store.

/// How many views a free account may keep. The starters count: they are
/// ordinary rows a person can delete, so a free account that wants a view of
/// its own makes room by dropping one it never opens.
export const MAX_FREE_VIEWS = 3;

/// Is there room for one more view? The only place the cap is decided — both
/// doors that make a view (the + in Settings, "save this search") ask here,
/// and hiding a button is never the guard.
export function viewLimitReached(views, premium) {
  return !premium && (views?.length || 0) >= MAX_FREE_VIEWS;
}
