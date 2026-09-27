// Whether a read/star/archive action applies to a set of target messages.
// "Mark read" only makes sense while something in the target is unread, and
// "mark unread" only while something is already read — a mixed target shows
// both sides. Same rule for star/unstar and archive/unarchive. An empty
// target shows neither side of any pair.
export function actionVisibility(emails) {
  const list = Array.isArray(emails) ? emails : [];
  const hasUnread = list.some(email => !email?.flags?.includes('\\Seen'));
  const hasRead = list.some(email => email?.flags?.includes('\\Seen'));
  const hasUnflagged = list.some(email => !email?.flags?.includes('\\Flagged'));
  const hasFlagged = list.some(email => email?.flags?.includes('\\Flagged'));
  const hasUnarchived = list.some(email => !email?.isArchived);
  const hasArchived = list.some(email => email?.isArchived);
  return {
    markRead: hasUnread,
    markUnread: hasRead,
    star: hasUnflagged,
    unstar: hasFlagged,
    archive: hasUnarchived,
    unarchive: hasArchived,
  };
}
