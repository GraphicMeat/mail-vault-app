// What the iframe makes unselectable with CSS (`.mv-pii{user-select:none}` in
// PRIVACY_FRAME_HEAD, the toggles' inline `user-select:none`), marked for the
// worker, which has no user-select: its textRuns and serialize skip these.
export function markUnselectable(doc) {
  for (const el of doc.querySelectorAll('.mv-pii, [data-quote-toggle], [data-mv-fold-toggle]')) {
    el.setAttribute('data-mv-noselect', '');
  }
}
