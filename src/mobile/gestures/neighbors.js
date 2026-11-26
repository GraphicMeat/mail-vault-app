// The message beside the open one in the list the viewer was opened from (the order the delete
// navigation uses): `dir` is 'next' (the row below) or 'prev'. Null at an end, when the list is
// gone or when that row is not loaded yet.
export function neighborRow(list, accountId, uid, dir) {
  if (!list) return null;
  const at = list.indexOf(list.keyFor(accountId, uid));
  if (at < 0) return null;
  const index = dir === 'next' ? at + 1 : at - 1;
  if (index < 0 || index >= (list.total ?? 0)) return null;
  const row = list.rowAt(index);
  return row ? { row, index } : null;
}
