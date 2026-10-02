import { describe, it, expect } from 'vitest';
import { buildRevealSet, revealAddressesOnly } from '../revealSender';

const spam = {
  from: { name: 'Prize Desk', address: 'Win@Prize.Example ' },
  replyTo: [{ address: 'collect@elsewhere.example' }],
  to: [{ name: 'Rokas Ambrazevičius', address: 'rokas@example.lt' }],
  cc: [{ address: 'owen@own.example' }],
};
const accounts = [{ id: 'a', email: 'rokas@example.lt', name: 'Rokas Ambrazevičius' }, { id: 'b', email: 'work@own.example' }];
const own = { accounts, sendAsAddresses: { b: 'billing@own.example' }, aliases: { a: [{ address: 'rokas.alias@example.lt' }] } };
const set = (m, o = own) => [...buildRevealSet(m, o)].sort();

describe('buildRevealSet', () => {
  it('the From address and name and the Reply-To addresses, lowercased and trimmed', () => {
    expect(set(spam)).toEqual(['collect@elsewhere.example', 'prize desk', 'win@prize.example']);
  });

  it('Reply-To may be one object, an array or a string', () => {
    expect(set({ ...spam, replyTo: { address: 'One@x.example' } })).toContain('one@x.example');
    expect(set({ ...spam, replyTo: 'two@x.example' })).toContain('two@x.example');
    expect(set({ ...spam, replyTo: [{ address: 'A@x.example' }, { address: 'b@x.example' }] })).toEqual(
      expect.arrayContaining(['a@x.example', 'b@x.example']));
    expect(set({ ...spam, replyTo: undefined })).toEqual(['prize desk', 'win@prize.example']);
  });

  it('a From that is your own account address, send-as or alias stays masked, name and all', () => {
    for (const address of ['rokas@example.lt', 'ROKAS@example.lt', 'billing@own.example', 'rokas.alias@example.lt', 'work@own.example']) {
      expect(set({ ...spam, from: { name: 'Prize Desk', address }, replyTo: undefined }), address).toEqual([]);
    }
  });

  it('a Gmail dot or plus variant of your own address is still you', () => {
    const o = { accounts: [{ id: 'g', email: 'jdoe@gmail.com' }] };
    expect(set({ from: { address: 'j.doe+news@gmail.com' } }, o)).toEqual([]);
  });

  it('a Reply-To that is you or a recipient is dropped, the From stays', () => {
    const m = { ...spam, replyTo: [{ address: 'rokas.alias@example.lt' }, { address: 'owen@own.example' }, { address: 'collect@elsewhere.example' }] };
    expect(set(m)).toEqual(['collect@elsewhere.example', 'prize desk', 'win@prize.example']);
  });

  it('a From that is a To or Cc recipient (mail to yourself) stays masked', () => {
    expect(set({ ...spam, from: { name: 'X', address: 'owen@own.example' }, replyTo: undefined })).toEqual([]);
  });

  it('a spoofed display name that is yours or a recipient\'s stays masked, the address does not', () => {
    expect(set({ ...spam, from: { name: 'rokas ambrazevičius', address: 'win@prize.example' }, replyTo: undefined })).toEqual(['win@prize.example']);
    expect(set({ ...spam, from: { name: 'Owen', address: 'win@prize.example' }, to: [{ name: 'Owen', address: 'o@x.example' }], replyTo: undefined })).toEqual(['win@prize.example']);
  });

  it('reads the "Name <addr>" string form', () => {
    expect(set({ from: 'Prize Desk <win@prize.example>', to: 'Rokas <rokas@example.lt>' })).toEqual(['prize desk', 'win@prize.example']);
  });

  it('with no accounts known, only the recipients are excluded', () => {
    expect(set(spam, {})).toEqual(['collect@elsewhere.example', 'prize desk', 'win@prize.example']);
    expect(set({ ...spam, from: { address: 'rokas@example.lt' } }, {})).toEqual(['collect@elsewhere.example']); // the recipient From is still excluded
  });

  describe('the display name is revealed only when it names nobody', () => {
    const base = { to: [{ name: 'Rokas Ambrazevičius', address: 'rokas@example.lt' }], replyTo: undefined };
    const withName = (name, extra = {}) => ({ ...base, from: { name, address: 'win@prize.example' }, ...extra });
    // The From address is still named when it is not the user's.
    const addressOnly = ['win@prize.example'];

    it('a name that is the user\'s own address, a recipient\'s address or a phone stays masked', () => {
      expect(set(withName('rokas@example.lt'))).toEqual(addressOnly);
      expect(set(withName('Rokas.Alias@example.lt'))).toEqual(addressOnly);
      expect(set(withName('owen@own.example', { cc: [{ address: 'owen@own.example' }] }))).toEqual(addressOnly);
      expect(set(withName('+370 612 34567'))).toEqual(addressOnly);
      expect(set(withName('Call 612 34567 now'))).toEqual(addressOnly);
    });

    it('a name that carries the user\'s or a recipient\'s name stays masked, whatever else it says', () => {
      for (const name of ['Rokas Ambrazevičius via DocuSign', 'Rokas, your parcel', 'ROKAS - action needed', 'Ambrazevičius Rokas', 'rokas, your parcel']) {
        expect(set(withName(name)), name).toEqual(addressOnly);
      }
      // The local part of an address of yours counts as your name.
      expect(set(withName('Rokas.Alias Support'))).toEqual(addressOnly);
      // And so do the recipients' (to or cc), by name and by address local part.
      expect(set(withName('Owen Ashcombe offers', { cc: [{ name: 'Owen Ashcombe', address: 'owen@own.example' }] }))).toEqual(addressOnly);
      expect(set(withName('Hello owen', { cc: [{ address: 'owen@own.example' }] }))).toEqual(addressOnly);
    });

    it('a spoofed contact name is revealed for the card; the app window shot keeps addresses only', () => {
      const reveal = buildRevealSet(withName('Joanna Kowalczyk'), own);
      expect([...reveal].sort()).toEqual(['joanna kowalczyk', 'win@prize.example']);
      expect([...revealAddressesOnly(reveal)]).toEqual(['win@prize.example']);
      expect(revealAddressesOnly(null)).toBe(null);
    });

    it('a plain brand name is still revealed beside the address', () => {
      expect(set(withName('Prize Desk'))).toEqual(['prize desk', 'win@prize.example']);
      expect(set(withName('DocuSign via Parcel Service'))).toEqual(['docusign via parcel service', 'win@prize.example']);
    });
  });
});
