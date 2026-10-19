// A contact as one recipient token: "Name <address>", or the bare address.
export function formatContact(c) {
  if (!c.name) return c.address;
  // RFC 5322: a display name containing specials must be a quoted-string,
  // or the comma reads as a recipient separator ("Doe, John" from an
  // address book would otherwise split into two broken recipients).
  const name = /[",;<>()@:[\]\\]/.test(c.name)
    ? `"${c.name.replace(/([\\"])/g, '\\$1')}"`
    : c.name;
  return `${name} <${c.address}>`;
}
