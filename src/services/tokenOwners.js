// Which account an OAuth access token was handed out for, so a Graph call that
// carries only the token still tells the daemon's Network Activity whose
// request it is. authUtils fills it: every token a Graph call uses passes
// through `ensureFreshToken`. Its own module so a test that mocks authUtils
// still gets the real lookup.
//
// Keyed by token, so a call still holding the token a refresh just replaced
// is still its account's. The newest few are kept: a token lives an hour.
const MAX = 64;
const owners = new Map();

export function rememberTokenOwner(token, email) {
  if (!token || !email) return;
  owners.delete(token);
  owners.set(token, email);
  if (owners.size > MAX) owners.delete(owners.keys().next().value);
}

export function tokenOwner(token) {
  return owners.get(token);
}
