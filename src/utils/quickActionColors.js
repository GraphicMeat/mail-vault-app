export const ACTION_COLORS = {
  archive: "var(--quick-action-archive)",
  unarchive: "var(--quick-action-unarchive)",
  delete: "var(--quick-action-delete)",
  deleteServer: "var(--quick-action-delete-server)",
  deleteEverywhere: "var(--quick-action-delete-everywhere)",
  toggleRead: "var(--quick-action-toggle-read)",
  markRead: "var(--quick-action-mark-read)",
  markUnread: "var(--quick-action-mark-unread)",
  star: "var(--quick-action-star)",
  unstar: "var(--quick-action-unstar)",
  tag: "var(--quick-action-tag)",
  move: "var(--quick-action-move)",
  spam: "var(--quick-action-spam)",
  reply: "var(--quick-action-reply)",
  replyAll: "var(--quick-action-reply-all)",
  forward: "var(--quick-action-forward)",
  replyTemplate: "var(--quick-action-reply-template)",
  export: "var(--quick-action-export)",
  newMessage: "var(--quick-action-new-message)",
  open: "var(--quick-action-open)",
  source: "var(--quick-action-source)",
  theme: "var(--quick-action-theme)",
};

/** Returns the rendered action color for a palette, or undefined for neutral. */
export function quickActionColorFor(entry, palette) {
  if (palette !== "semantic" && palette !== "custom") return undefined;
  const fallback = ACTION_COLORS[entry?.action] || "var(--mail-accent)";
  return palette === "custom" ? entry?.color || fallback : fallback;
}
