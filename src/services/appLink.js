/**
 * A mailvaultapp.com page opened from inside the app carries
 * `utm_source=app&utm_medium=<where>`, so the site's analytics can tell an app
 * visit from a search or a shared link, and which button sent it. The tag goes
 * before any `#fragment`, which must stay last for the anchor to work.
 */
export function appLink(url, medium) {
  const cut = url.indexOf('#');
  const base = cut === -1 ? url : url.slice(0, cut);
  const fragment = cut === -1 ? '' : url.slice(cut);
  return `${base}${base.includes('?') ? '&' : '?'}utm_source=app&utm_medium=${encodeURIComponent(medium)}${fragment}`;
}
