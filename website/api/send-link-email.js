// "Email me the download link": the mail a phone visitor sends to themselves,
// plus the small confirm page behind its "Yes, send me updates" button.
//
// Pure functions only, so the template is testable without booting the API.
// Nothing the requester typed reaches the mail except the address it goes to:
// every string below is ours, picked by a whitelisted locale.
//
// MailVault tells people that "senders learn nothing", so this mail carries no
// remote images, no tracking pixel and no redirect or click-tracking links. The
// brand is a styled text wordmark rather than a logo image for the same reason.

const ORIGIN = 'https://mailvaultapp.com';
const CAMPAIGN = 'utm_source=email_link&utm_medium=email&utm_campaign=mobile_handoff';

// Site locale dirs (website/i18n/i18n.mjs LOCALES) and the demo's app language.
const LOCALES = {
  en: { dir: '', app: 'en', html: 'en' },
  de: { dir: 'de', app: 'de', html: 'de' },
  fr: { dir: 'fr', app: 'fr', html: 'fr' },
  es: { dir: 'es', app: 'es', html: 'es' },
  it: { dir: 'it', app: 'it', html: 'it' },
  ja: { dir: 'ja', app: 'ja', html: 'ja' },
  ko: { dir: 'ko', app: 'ko', html: 'ko' },
  zh: { dir: 'zh', app: 'zh-Hans', html: 'zh-Hans' },
  'pt-br': { dir: 'pt-br', app: 'pt-BR', html: 'pt-BR' },
};
const ALIASES = { 'zh-hans': 'zh', 'zh-cn': 'zh', pt: 'pt-br' };

// Any input, including garbage, maps to one of the keys above.
function resolveLocale(lang) {
  const l = String(lang || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOCALES, l)) return l;
  return ALIASES[l] || 'en';
}

const COPY = {
  en: {
    subject: 'Your MailVault download link',
    preheader: 'Open this email on your computer to download MailVault.',
    heading: 'Here is your download link',
    intro: 'You asked for this link on your phone. Open this email on your computer to download MailVault, the free private email app for macOS, Windows and Linux.',
    button: 'Download MailVault',
    demoLead: 'Want to look around first?',
    demoLink: 'Try the live demo',
    updatesQuestion: 'Want to hear when new versions ship?',
    updatesButton: 'Yes, send me updates',
    updatesNo: 'No? Do nothing. We will not email you again.',
    footerWhy: 'You got this email because someone entered this address at mailvaultapp.com and asked for the MailVault download link. If that was not you, ignore it and nothing more will happen.',
    footerBrand: 'MailVault by Graphic Meat',
    confirmTitle: 'Get MailVault updates?',
    confirmBody: 'We will email you when a new version of MailVault ships. Unsubscribe anytime.',
    confirmNo: 'Changed your mind? Close this page. Nothing happens unless you press the button.',
  },
  de: {
    subject: 'Dein MailVault-Downloadlink',
    preheader: 'Öffne diese E-Mail auf deinem Computer, um MailVault herunterzuladen.',
    heading: 'Hier ist dein Downloadlink',
    intro: 'Du hast diesen Link auf deinem Handy angefordert. Öffne diese E-Mail auf deinem Computer, um MailVault herunterzuladen, die kostenlose, private E-Mail-App für macOS, Windows und Linux.',
    button: 'MailVault herunterladen',
    demoLead: 'Erst mal umsehen?',
    demoLink: 'Live-Demo ausprobieren',
    updatesQuestion: 'Möchtest du erfahren, wenn neue Versionen erscheinen?',
    updatesButton: 'Ja, schickt mir Updates',
    updatesNo: 'Nein? Dann tu einfach nichts. Wir schreiben dir nicht noch einmal.',
    footerWhy: 'Du erhältst diese E-Mail, weil jemand diese Adresse auf mailvaultapp.com eingegeben und den MailVault-Downloadlink angefordert hat. Warst du das nicht, ignoriere sie einfach. Es passiert nichts weiter.',
    footerBrand: 'MailVault von Graphic Meat',
    confirmTitle: 'MailVault-Updates erhalten?',
    confirmBody: 'Wir schreiben dir, wenn eine neue Version von MailVault erscheint. Jederzeit abbestellbar.',
    confirmNo: 'Doch nicht? Schließ einfach diese Seite. Ohne Klick auf den Button passiert nichts.',
  },
  fr: {
    subject: 'Votre lien de téléchargement MailVault',
    preheader: 'Ouvrez cet e-mail sur votre ordinateur pour télécharger MailVault.',
    heading: 'Voici votre lien de téléchargement',
    intro: "Vous avez demandé ce lien sur votre téléphone. Ouvrez cet e-mail sur votre ordinateur pour télécharger MailVault, l'app e-mail gratuite et privée pour macOS, Windows et Linux.",
    button: 'Télécharger MailVault',
    demoLead: "Envie de jeter un œil d'abord ?",
    demoLink: 'Essayer la démo en direct',
    updatesQuestion: 'Voulez-vous être prévenu des nouvelles versions ?',
    updatesButton: 'Oui, tenez-moi au courant',
    updatesNo: 'Non ? Ne faites rien. Nous ne vous écrirons plus.',
    footerWhy: "Vous recevez cet e-mail parce que quelqu'un a saisi cette adresse sur mailvaultapp.com pour demander le lien de téléchargement de MailVault. Si ce n'était pas vous, ignorez-le : rien d'autre ne se passera.",
    footerBrand: 'MailVault par Graphic Meat',
    confirmTitle: 'Recevoir les nouveautés de MailVault ?',
    confirmBody: 'Nous vous écrirons quand une nouvelle version de MailVault sortira. Désabonnez-vous à tout moment.',
    confirmNo: "Vous avez changé d'avis ? Fermez cette page. Rien ne se passe sans clic sur le bouton.",
  },
  es: {
    subject: 'Tu enlace de descarga de MailVault',
    preheader: 'Abre este correo en tu ordenador para descargar MailVault.',
    heading: 'Aquí tienes tu enlace de descarga',
    intro: 'Pediste este enlace desde tu móvil. Abre este correo en tu ordenador para descargar MailVault, la app de correo gratis y privada para macOS, Windows y Linux.',
    button: 'Descargar MailVault',
    demoLead: '¿Quieres echar un vistazo antes?',
    demoLink: 'Prueba la demo en directo',
    updatesQuestion: '¿Quieres saber cuándo salen nuevas versiones?',
    updatesButton: 'Sí, quiero recibir novedades',
    updatesNo: '¿No? No hagas nada. No volveremos a escribirte.',
    footerWhy: 'Recibes este correo porque alguien escribió esta dirección en mailvaultapp.com y pidió el enlace de descarga de MailVault. Si no fuiste tú, ignóralo y no pasará nada más.',
    footerBrand: 'MailVault, de Graphic Meat',
    confirmTitle: '¿Recibir novedades de MailVault?',
    confirmBody: 'Te escribiremos cuando salga una nueva versión de MailVault. Cancela la suscripción cuando quieras.',
    confirmNo: '¿Has cambiado de idea? Cierra esta página. No pasa nada si no pulsas el botón.',
  },
  it: {
    subject: 'Il tuo link per scaricare MailVault',
    preheader: 'Apri questa email sul computer per scaricare MailVault.',
    heading: 'Ecco il tuo link per il download',
    intro: "Hai chiesto questo link dal telefono. Apri questa email sul computer per scaricare MailVault, l'app email gratuita e privata per macOS, Windows e Linux.",
    button: 'Scarica MailVault',
    demoLead: "Vuoi prima dare un'occhiata?",
    demoLink: 'Prova la demo dal vivo',
    updatesQuestion: 'Vuoi sapere quando escono nuove versioni?',
    updatesButton: 'Sì, inviatemi gli aggiornamenti',
    updatesNo: 'No? Non fare nulla. Non ti scriveremo più.',
    footerWhy: 'Ricevi questa email perché qualcuno ha inserito questo indirizzo su mailvaultapp.com per chiedere il link di download di MailVault. Se non sei stato tu, ignorala: non succederà altro.',
    footerBrand: 'MailVault di Graphic Meat',
    confirmTitle: 'Ricevere gli aggiornamenti di MailVault?',
    confirmBody: 'Ti scriveremo quando esce una nuova versione di MailVault. Disiscriviti quando vuoi.',
    confirmNo: 'Hai cambiato idea? Chiudi questa pagina. Senza premere il pulsante non succede nulla.',
  },
  ja: {
    subject: 'MailVault のダウンロードリンク',
    preheader: 'このメールをパソコンで開いて MailVault をダウンロードしてください。',
    heading: 'ダウンロードリンクをお届けします',
    intro: 'スマートフォンからこのリンクをリクエストいただきました。このメールをパソコンで開き、macOS、Windows、Linux 向けの無料でプライベートなメールアプリ MailVault をダウンロードしてください。',
    button: 'MailVault をダウンロード',
    demoLead: 'まずは中を見てみたいですか？',
    demoLink: 'ライブデモを試す',
    updatesQuestion: '新しいバージョンのお知らせを受け取りますか？',
    updatesButton: 'はい、お知らせを受け取ります',
    updatesNo: '不要な場合は何もしないでください。今後メールをお送りすることはありません。',
    footerWhy: 'このメールは、mailvaultapp.com でこのアドレスが入力され、MailVault のダウンロードリンクがリクエストされたためお送りしています。お心当たりがない場合は無視してください。これ以上何も起きません。',
    footerBrand: 'MailVault by Graphic Meat',
    confirmTitle: 'MailVault のお知らせを受け取りますか？',
    confirmBody: 'MailVault の新しいバージョンが出たときにメールでお知らせします。いつでも配信解除できます。',
    confirmNo: '気が変わった場合は、このページを閉じてください。ボタンを押さない限り何も起きません。',
  },
  ko: {
    subject: 'MailVault 다운로드 링크',
    preheader: '컴퓨터에서 이 이메일을 열어 MailVault를 다운로드하세요.',
    heading: '다운로드 링크를 보내 드립니다',
    intro: '휴대폰에서 이 링크를 요청하셨습니다. 컴퓨터에서 이 이메일을 열어 macOS, Windows, Linux용 무료 개인 이메일 앱 MailVault를 다운로드하세요.',
    button: 'MailVault 다운로드',
    demoLead: '먼저 둘러보고 싶으신가요?',
    demoLink: '라이브 데모 사용해 보기',
    updatesQuestion: '새 버전이 나올 때 소식을 받으시겠습니까?',
    updatesButton: '예, 소식을 받겠습니다',
    updatesNo: '원하지 않으시면 아무것도 하지 않으셔도 됩니다. 다시 이메일을 보내지 않습니다.',
    footerWhy: '누군가 mailvaultapp.com에서 이 주소를 입력하고 MailVault 다운로드 링크를 요청했기 때문에 이 이메일을 받으셨습니다. 본인이 아니라면 무시하셔도 되며, 더 이상 아무 일도 일어나지 않습니다.',
    footerBrand: 'MailVault by Graphic Meat',
    confirmTitle: 'MailVault 소식을 받으시겠습니까?',
    confirmBody: 'MailVault 새 버전이 나오면 이메일로 알려 드립니다. 언제든 구독을 취소할 수 있습니다.',
    confirmNo: '마음이 바뀌셨나요? 이 페이지를 닫으세요. 버튼을 누르지 않으면 아무 일도 일어나지 않습니다.',
  },
  zh: {
    subject: '你的 MailVault 下载链接',
    preheader: '请在电脑上打开这封邮件来下载 MailVault。',
    heading: '这是你的下载链接',
    intro: '你在手机上请求了这个链接。请在电脑上打开这封邮件，下载 MailVault：适用于 macOS、Windows 和 Linux 的免费私密邮箱应用。',
    button: '下载 MailVault',
    demoLead: '想先看看？',
    demoLink: '试用在线演示',
    updatesQuestion: '想在新版本发布时收到通知吗？',
    updatesButton: '好的，给我发送更新',
    updatesNo: '不需要？什么都不用做。我们不会再给你发邮件。',
    footerWhy: '你收到这封邮件，是因为有人在 mailvaultapp.com 输入了这个地址并请求 MailVault 下载链接。如果不是你本人，请忽略此邮件，之后不会再有任何操作。',
    footerBrand: 'MailVault 由 Graphic Meat 出品',
    confirmTitle: '接收 MailVault 更新通知？',
    confirmBody: 'MailVault 发布新版本时，我们会发邮件通知你。可随时取消订阅。',
    confirmNo: '改主意了？关闭此页面即可。不点按钮就什么都不会发生。',
  },
  'pt-br': {
    subject: 'Seu link para baixar o MailVault',
    preheader: 'Abra este e-mail no computador para baixar o MailVault.',
    heading: 'Aqui está seu link de download',
    intro: 'Você pediu este link pelo celular. Abra este e-mail no computador para baixar o MailVault, o app de e-mail grátis e privado para macOS, Windows e Linux.',
    button: 'Baixar o MailVault',
    demoLead: 'Quer dar uma olhada antes?',
    demoLink: 'Experimente a demonstração ao vivo',
    updatesQuestion: 'Quer saber quando saírem novas versões?',
    updatesButton: 'Sim, quero receber novidades',
    updatesNo: 'Não? Não faça nada. Não vamos escrever de novo.',
    footerWhy: 'Você recebeu este e-mail porque alguém digitou este endereço em mailvaultapp.com e pediu o link de download do MailVault. Se não foi você, ignore. Nada mais vai acontecer.',
    footerBrand: 'MailVault, da Graphic Meat',
    confirmTitle: 'Receber novidades do MailVault?',
    confirmBody: 'Vamos avisar por e-mail quando sair uma nova versão do MailVault. Cancele quando quiser.',
    confirmNo: 'Mudou de ideia? Feche esta página. Nada acontece sem tocar no botão.',
  },
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function localePath(locale) {
  const { dir } = LOCALES[locale];
  return dir ? `/${dir}/` : '/';
}

// The homepage's #download section offers the installer for the OS it is opened
// on (english-site.js reads the user agent), which is exactly what a desktop
// visitor arriving from this mail needs.
function linksFor(lang, token) {
  const locale = resolveLocale(lang);
  return {
    downloadUrl: `${ORIGIN}${localePath(locale)}?${CAMPAIGN}#download`,
    demoUrl: `${ORIGIN}/demo/?lang=${encodeURIComponent(LOCALES[locale].app)}&${CAMPAIGN}`,
    // Lands on the API, which shows a one-button confirm form; a GET never subscribes.
    subscribeUrl: `${ORIGIN}/api/send-link/confirm?t=${encodeURIComponent(token)}&lang=${encodeURIComponent(locale)}`,
  };
}

// Colours: light card on a soft indigo-grey page, brand indigo for the wordmark
// and button. Every table sets its own background, so a client that inverts for
// dark mode inverts consistently, and the <style> block gives Apple Mail and
// other clients that honour prefers-color-scheme a real dark version.
const C = {
  page: '#eef0f7', card: '#ffffff', ink: '#20212c', muted: '#575b69', line: '#d9dce6',
  brand: '#6366f1', button: '#4f46e5', buttonInk: '#ffffff', soft: '#f5f5ff',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function buildSendLinkEmail(lang, { downloadUrl, demoUrl, subscribeUrl }) {
  const locale = resolveLocale(lang);
  const t = COPY[locale];
  const e = escapeHtml;
  const htmlLang = LOCALES[locale].html;

  const text = [
    t.heading,
    '',
    t.intro,
    '',
    `${t.button}:`,
    downloadUrl,
    '',
    `${t.demoLead} ${t.demoLink}:`,
    demoUrl,
    '',
    t.updatesQuestion,
    `${t.updatesButton}:`,
    subscribeUrl,
    t.updatesNo,
    '',
    '--',
    t.footerWhy,
    t.footerBrand,
    '',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="${e(htmlLang)}">
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
    .mv-soft { background-color: #24253a !important; }
    .mv-brand { color: #a5a8ff !important; }
    .mv-link { color: #b2adff !important; }
    .mv-ghost { color: #c9c6ff !important; border-color: #6366f1 !important; }
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
    <tr><td style="padding:32px 28px 8px;font-family:${FONT};">
      <h1 class="mv-ink" style="margin:0 0 14px;font-size:24px;line-height:1.3;font-weight:700;color:${C.ink};">${e(t.heading)}</h1>
      <p class="mv-ink" style="margin:0 0 26px;font-size:16px;line-height:1.6;color:${C.ink};">${e(t.intro)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
      <tr><td align="center" bgcolor="${C.button}" style="border-radius:8px;background-color:${C.button};">
        <a href="${e(downloadUrl)}" style="display:inline-block;border-top:14px solid ${C.button};border-bottom:14px solid ${C.button};border-left:30px solid ${C.button};border-right:30px solid ${C.button};border-radius:8px;background-color:${C.button};color:${C.buttonInk};font-family:${FONT};font-size:17px;font-weight:700;line-height:1.2;text-decoration:none;">${e(t.button)}</a>
      </td></tr>
      </table>
      <p class="mv-muted" style="margin:0 0 28px;font-size:15px;line-height:1.6;color:${C.muted};">${e(t.demoLead)} <a class="mv-link" href="${e(demoUrl)}" style="color:${C.button};font-weight:600;text-decoration:underline;">${e(t.demoLink)}</a></p>
    </td></tr>
    <tr><td style="padding:0 28px 30px;font-family:${FONT};">
      <table role="presentation" class="mv-soft" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.soft}" style="background-color:${C.soft};border-radius:10px;">
      <tr><td style="padding:20px 22px;font-family:${FONT};">
        <p class="mv-ink" style="margin:0 0 14px;font-size:16px;line-height:1.5;font-weight:600;color:${C.ink};">${e(t.updatesQuestion)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
        <tr><td style="border-radius:8px;">
          <a class="mv-ghost" href="${e(subscribeUrl)}" style="display:inline-block;border:2px solid ${C.button};border-radius:8px;padding:10px 20px;color:${C.button};font-family:${FONT};font-size:15px;font-weight:700;line-height:1.2;text-decoration:none;">${e(t.updatesButton)}</a>
        </td></tr>
        </table>
        <p class="mv-muted" style="margin:0;font-size:14px;line-height:1.5;color:${C.muted};">${e(t.updatesNo)}</p>
      </td></tr>
      </table>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 10px 0;font-family:${FONT};">
    <p class="mv-muted" style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${C.muted};">${e(t.footerWhy)}</p>
    <p class="mv-muted" style="margin:0;font-size:12px;line-height:1.6;color:${C.muted};">${e(t.footerBrand)}</p>
  </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;

  return { subject: t.subject, text, html };
}

// The page behind "Yes, send me updates". It is rendered here, not served as a
// static file, because it has to work with JavaScript off: a static page cannot
// copy the token from its own URL into a POST without a script, Caddy hands only
// /api/* to this process, and its Referrer-Policy is no-referrer. Rendering the
// token into a hidden field here gives a plain one-button form, and the GET that
// shows it never subscribes anyone (link scanners and prefetchers follow GETs).
function renderConfirmPage(lang, token) {
  const locale = resolveLocale(lang);
  const t = COPY[locale];
  const e = escapeHtml;
  return `<!DOCTYPE html>
<html lang="${e(LOCALES[locale].html)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${e(t.confirmTitle)}</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px; box-sizing:border-box; background:${C.page}; color:${C.ink}; font-family:${FONT}; }
  main { max-width:460px; width:100%; background:${C.card}; border:1px solid ${C.line}; border-radius:16px; padding:32px 28px; box-sizing:border-box; }
  .brand { display:inline-block; margin-bottom:18px; font-size:22px; font-weight:800; letter-spacing:-.02em; color:${C.brand}; text-decoration:none; }
  h1 { margin:0 0 10px; font-size:24px; line-height:1.3; }
  p { margin:0 0 22px; line-height:1.6; color:${C.muted}; }
  button { font:inherit; font-size:16px; font-weight:700; color:#fff; background:${C.button}; border:0; border-radius:8px; padding:14px 26px; min-height:48px; cursor:pointer; }
  button:hover { background:#3e35c8; }
  .note { margin:18px 0 0; font-size:14px; }
  @media (prefers-color-scheme: dark) {
    body { background:#0f1020; color:#f3f3f8; }
    main { background:#1c1d2e; border-color:#34374a; }
    p { color:#b4b8ca; }
    .brand { color:#a5a8ff; }
  }
</style>
</head>
<body>
<main>
<a class="brand" href="${e(localePath(locale))}">MailVault</a>
<h1>${e(t.confirmTitle)}</h1>
<p>${e(t.confirmBody)}</p>
<form method="post" action="/api/send-link/subscribe">
<input type="hidden" name="t" value="${e(token)}">
<input type="hidden" name="lang" value="${e(locale)}">
<button type="submit">${e(t.updatesButton)}</button>
</form>
<p class="note">${e(t.confirmNo)}</p>
</main>
</body>
</html>
`;
}

module.exports = { LOCALES, COPY, resolveLocale, linksFor, buildSendLinkEmail, renderConfirmPage, escapeHtml, localePath };
