import { describe, it, expect } from 'vitest';
import { mentionsAttachment, missingAttachment } from '../missingAttachment';

describe('mentionsAttachment', () => {
  it.each([
    ['en', 'Please find the report attached.'],
    ['en', 'See the attachment for details'],
    ['en', 'I am attaching the slides'],
    ['en', 'The contract is enclosed.'],
    ['de', 'Im Anhang findest du die Rechnung.'],
    ['de', 'Ich habe die Datei angehängt.'],
    ['de', 'Anbei das Protokoll.'],
    ['es', 'Te envío el archivo adjunto.'],
    ['es', 'Adjunto la factura.'],
    ['fr', 'Voici la pièce jointe.'],
    ['fr', 'Veuillez trouver ci-joint le devis.'],
    ['it', 'Trovi il file in allegato.'],
    ['it', 'Ti ho allegato il documento.'],
    ['pt-BR', 'Segue o arquivo em anexo.'],
    ['pt-BR', 'Anexei o contrato.'],
    ['ja', '資料を添付します。'],
    ['ko', '파일을 첨부합니다.'],
    ['zh-Hans', '请查看附件。'],
  ])('%s: "%s"', (_lang, text) => {
    expect(mentionsAttachment(text)).toBe(true);
  });

  it.each([
    'Thanks, talk tomorrow.',
    'A detached view.',
    'Let us meet at the Anhalter Bahnhof.',
    'This is a joint venture.',
    'The building has an annex.',
    '',
  ])('no mention: "%s"', (text) => {
    expect(mentionsAttachment(text)).toBe(false);
  });

  it('matches whole words only, accents included', () => {
    expect(mentionsAttachment('unattached')).toBe(false);
    expect(mentionsAttachment('reattachment')).toBe(false);
    expect(mentionsAttachment('Anhänger')).toBe(false);
  });

  it('ignores quoted lines and the signature', () => {
    expect(mentionsAttachment('Sounds good.\n> I attached the file')).toBe(false);
    expect(mentionsAttachment('Sounds good.\n\n--\nJo\nAttachments may be confidential.')).toBe(false);
    expect(mentionsAttachment('Sounds good.\n-- \nJo, see attached policy')).toBe(false);
  });
});

describe('missingAttachment', () => {
  const base = { mode: 'new', subject: '', bodyText: '', attachmentCount: 0 };

  it('flags a body mention with nothing attached', () => {
    expect(missingAttachment({ ...base, bodyText: 'Report attached.' })).toBe(true);
  });

  it('is quiet once anything is attached', () => {
    expect(missingAttachment({ ...base, bodyText: 'Report attached.', attachmentCount: 1 })).toBe(false);
  });

  it('reads the subject of a new message', () => {
    expect(missingAttachment({ ...base, subject: 'Invoice attached' })).toBe(true);
  });

  it("ignores a reply's or forward's subject: it is the original's", () => {
    expect(missingAttachment({ ...base, mode: 'reply', subject: 'Re: Invoice attached', bodyText: 'Paid, thanks.' })).toBe(false);
    expect(missingAttachment({ ...base, mode: 'forward', subject: 'Fwd: see attachment' })).toBe(false);
  });
});
