// "Confirm your updates subscription": the one mail a newsletter sign-up
// sends. Nobody is subscribed until its button is pressed, so a bot typing
// other people's addresses into the form gets each of them one short mail and
// no subscription, and a typo costs only that mail.
//
// The button is the existing send-link confirm link (a GET that shows a
// one-button page and never subscribes), so this reuses that page, token and
// subscribe endpoint. Same rules as the send-link mail: ours strings only, no
// remote images, no tracking, links straight at mailvaultapp.com.
const { COPY: LINK_COPY, resolveLocale, linksFor, escapeHtml, LOCALES, C, FONT } = require('./send-link-email');

const COPY = {
  en: {
    subject: 'Confirm your MailVault updates subscription',
    preheader: 'One tap to confirm your email address.',
    heading: 'Confirm your email',
    intro: 'Someone entered this address at mailvaultapp.com to get MailVault updates. Press the button to confirm it is yours. We will email you when a new version ships.',
    fallback: 'Button not working? Paste this link into your browser:',
    ignore: 'Not you? Ignore this email and nothing will happen.',
  },
  de: {
    subject: 'Bestätige dein Abo der MailVault-Neuigkeiten',
    preheader: 'Ein Tipp, um deine E-Mail-Adresse zu bestätigen.',
    heading: 'Bestätige deine E-Mail-Adresse',
    intro: 'Jemand hat diese Adresse auf mailvaultapp.com eingegeben, um MailVault-Neuigkeiten zu erhalten. Tippe auf die Schaltfläche, um zu bestätigen, dass sie dir gehört. Wir schreiben dir, wenn eine neue Version erscheint.',
    fallback: 'Die Schaltfläche funktioniert nicht? Füge diesen Link in deinen Browser ein:',
    ignore: 'Nicht du? Ignoriere diese E-Mail, dann passiert nichts.',
  },
  fr: {
    subject: 'Confirmez votre abonnement aux nouveautés MailVault',
    preheader: 'Un appui pour confirmer votre adresse e-mail.',
    heading: 'Confirmez votre adresse e-mail',
    intro: "Quelqu'un a saisi cette adresse sur mailvaultapp.com pour recevoir les nouveautés de MailVault. Appuyez sur le bouton pour confirmer qu'elle est bien la vôtre. Nous vous écrirons à la sortie d'une nouvelle version.",
    fallback: 'Le bouton ne fonctionne pas ? Collez ce lien dans votre navigateur :',
    ignore: "Ce n'était pas vous ? Ignorez cet e-mail, il ne se passera rien.",
  },
  es: {
    subject: 'Confirma tu suscripción a las novedades de MailVault',
    preheader: 'Un toque para confirmar tu dirección de correo.',
    heading: 'Confirma tu correo electrónico',
    intro: 'Alguien introdujo esta dirección en mailvaultapp.com para recibir las novedades de MailVault. Pulsa el botón para confirmar que es tuya. Te escribiremos cuando salga una nueva versión.',
    fallback: '¿No funciona el botón? Pega este enlace en tu navegador:',
    ignore: '¿No fuiste tú? Ignora este correo y no pasará nada.',
  },
  it: {
    subject: 'Conferma l’iscrizione alle novità di MailVault',
    preheader: 'Un tocco per confermare il tuo indirizzo e-mail.',
    heading: 'Conferma il tuo indirizzo e-mail',
    intro: "Qualcuno ha inserito questo indirizzo su mailvaultapp.com per ricevere le novità di MailVault. Premi il pulsante per confermare che è il tuo. Ti scriveremo quando uscirà una nuova versione.",
    fallback: 'Il pulsante non funziona? Incolla questo link nel browser:',
    ignore: 'Non sei stato tu? Ignora questa e-mail e non succederà nulla.',
  },
  'pt-br': {
    subject: 'Confirme sua inscrição nas novidades do MailVault',
    preheader: 'Um toque para confirmar seu endereço de e-mail.',
    heading: 'Confirme seu e-mail',
    intro: 'Alguém digitou este endereço em mailvaultapp.com para receber as novidades do MailVault. Toque no botão para confirmar que é seu. Vamos avisar por e-mail quando sair uma nova versão.',
    fallback: 'O botão não funciona? Cole este link no navegador:',
    ignore: 'Não foi você? Ignore este e-mail e nada vai acontecer.',
  },
  ja: {
    subject: 'MailVaultの最新情報の購読を確認してください',
    preheader: 'ボタンを押して、メールアドレスを確認してください。',
    heading: 'メールアドレスの確認',
    intro: 'mailvaultapp.com でこのアドレスが入力され、MailVaultの最新情報の購読が申し込まれました。ご本人であれば、ボタンを押して確認してください。新しいバージョンが出たらお知らせします。',
    fallback: 'ボタンが動作しない場合は、このリンクをブラウザに貼り付けてください:',
    ignore: '心当たりがない場合は、このメールを無視してください。何も起こりません。',
  },
  ko: {
    subject: 'MailVault 소식 구독을 확인해 주세요',
    preheader: '버튼을 눌러 이메일 주소를 확인해 주세요.',
    heading: '이메일 주소 확인',
    intro: '누군가 mailvaultapp.com에서 이 주소를 입력해 MailVault 소식을 신청했습니다. 본인이 맞다면 버튼을 눌러 확인해 주세요. 새 버전이 나오면 이메일로 알려 드립니다.',
    fallback: '버튼이 작동하지 않나요? 이 링크를 브라우저에 붙여 넣으세요:',
    ignore: '본인이 아니라면 이 이메일을 무시하세요. 아무 일도 일어나지 않습니다.',
  },
  zh: {
    subject: '请确认订阅 MailVault 更新',
    preheader: '点按一下，确认你的邮箱地址。',
    heading: '确认你的邮箱',
    intro: '有人在 mailvaultapp.com 输入了这个地址，想接收 MailVault 更新通知。如果是你本人，请点按按钮确认。新版本发布时，我们会发邮件通知你。',
    fallback: '按钮无法使用？请把这个链接粘贴到浏览器中：',
    ignore: '不是你本人？忽略这封邮件即可，什么都不会发生。',
  },
};

function buildSubscribeConfirmEmail(lang, token) {
  const locale = resolveLocale(lang);
  const t = COPY[locale];
  const shared = LINK_COPY[locale];
  const url = linksFor(lang, token).subscribeUrl;
  const e = escapeHtml;

  const text = [
    t.heading,
    '',
    t.intro,
    '',
    `${shared.updatesButton}:`,
    url,
    '',
    t.ignore,
    '',
    '--',
    shared.footerBrand,
    '',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="${e(LOCALES[locale].html)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(t.subject)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .mv-page { background-color: #0f1020 !important; }
    .mv-card { background-color: #1c1d2e !important; border-color: #34374a !important; }
    .mv-ink { color: #f3f3f8 !important; }
    .mv-muted { color: #b4b8ca !important; }
    .mv-brand { color: #a5a8ff !important; }
    .mv-link { color: #b2adff !important; }
  }
</style>
</head>
<body class="mv-page" style="margin:0;padding:0;background-color:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${e(t.preheader)}</div>
<table role="presentation" class="mv-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
  <tr><td style="padding:0 8px 18px;font-family:${FONT};">
    <span class="mv-brand" style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:${C.brand};">MailVault</span>
  </td></tr>
  <tr><td>
    <table role="presentation" class="mv-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:14px;">
    <tr><td style="padding:32px 28px 30px;font-family:${FONT};">
      <h1 class="mv-ink" style="margin:0 0 14px;font-size:24px;line-height:1.3;font-weight:700;color:${C.ink};">${e(t.heading)}</h1>
      <p class="mv-ink" style="margin:0 0 26px;font-size:16px;line-height:1.6;color:${C.ink};">${e(t.intro)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
      <tr><td align="center" bgcolor="${C.button}" style="border-radius:8px;background-color:${C.button};">
        <a href="${e(url)}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:16px;font-weight:700;line-height:1.2;color:${C.buttonInk};text-decoration:none;border-radius:8px;">${e(shared.updatesButton)}</a>
      </td></tr>
      </table>
      <p class="mv-muted" style="margin:0 0 6px;font-size:13px;line-height:1.5;color:${C.muted};">${e(t.fallback)}</p>
      <p style="margin:0 0 20px;font-size:13px;line-height:1.5;word-break:break-all;"><a class="mv-link" href="${e(url)}" style="color:${C.button};">${e(url)}</a></p>
      <p class="mv-muted" style="margin:0;font-size:14px;line-height:1.5;color:${C.muted};">${e(t.ignore)}</p>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 10px 0;font-family:${FONT};">
    <p class="mv-muted" style="margin:0;font-size:12px;line-height:1.6;color:${C.muted};">${e(shared.footerBrand)}</p>
  </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: t.subject, text, html };
}

module.exports = { buildSubscribeConfirmEmail, COPY };
