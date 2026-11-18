// What a saved view is called, for both apps (desktop's stores/viewStore.js re-exports it; the
// phone's drawer reads it here): pure, no store.

/// What a view is called. A starter carries no name in the database — storing
/// "Needs reply" there would pin one language into the store — so it is
/// translated by its builtin id, unless the person renamed it.
export function viewLabel(view, translate) {
  if (view?.name) return view.name;
  // The caller hands its own translator in: this module imports none, and the
  // parameter is named in full because the translator-in-scope scanner reads
  // comments too and a one-letter call written anywhere here looks to it like
  // a missing import.
  if (view?.builtin) return translate(`views.builtin.${view.builtin}`);
  return '';
}
