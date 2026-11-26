// The colour of a folder glyph on the phone: desktop's rule (src/utils/folderIconColor.js) over
// the phone's `folderIconStyle` and `folderIconColors` preferences. One function for every place
// the phone draws a folder (the drawer, the move picker), so they never disagree.
import {
  folderColorKey, folderIconColor, normalizeFolderIconColors, normalizeFolderIconStyle,
} from '../../utils/folderIconColor.js';
import { iconMailbox } from '../folders.js';

/** The key a colour picked for `folder` of `accountId` is saved under. */
export function folderPickKey(folder, accountId) {
  return folderColorKey(accountId, iconMailbox(folder).path);
}

/** The glyph colour for `folder` of `accountId`; `prefs` are the phone's preferences. */
export function phoneFolderColor(folder, accountId, prefs) {
  return folderIconColor(iconMailbox(folder), {
    style: normalizeFolderIconStyle(prefs?.folderIconStyle),
    colors: normalizeFolderIconColors(prefs?.folderIconColors),
    accountId,
  });
}

/** `prefs.folderIconColors` with `folder`'s pick set to `color`, or taken away for null. */
export function withFolderPick(prefs, folder, accountId, color) {
  const { [folderPickKey(folder, accountId)]: _old, ...rest } = normalizeFolderIconColors(prefs?.folderIconColors);
  return color ? { ...rest, [folderPickKey(folder, accountId)]: color } : rest;
}
