// The mail that carries a Premium sign-in code (signin-code.js), for the phone and the computer. Pure functions,
// nine locales shared with the email-me-the-link mail. Nothing the requester
// typed reaches the body except the code we generated: no links, two static
// pictures from our own site (icon, illustration) and nothing else remote, no tracking, and the code is not in the subject line.
const { LOCALES, resolveLocale, escapeHtml } = require('./send-link-email');

const COPY = {
  'en': {
    subject: 'Your MailVault sign-in code',
    heading: 'Your sign-in code',
    intro: 'Enter this code in MailVault to sign in to Premium.',
    autofill: 'If MailVault is open, it fills the code in for you.',
    heroAlt: 'A sealed envelope sends a key to a computer, which unlocks.',
    expires: 'The code works once and expires in 10 minutes.',
    ignore: 'If you did not ask for it, ignore this email. Nobody can sign in without the code.',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'de': {
    subject: 'Dein MailVault-Anmeldecode',
    heading: 'Dein Anmeldecode',
    intro: 'Gib diesen Code in MailVault ein, um dich bei Premium anzumelden.',
    autofill: 'Ist MailVault geöffnet, trägt es den Code für dich ein.',
    heroAlt: 'Ein versiegelter Umschlag schickt einen Schlüssel an einen Computer, der sich entsperrt.',
    expires: 'Der Code gilt einmal und läuft in 10 Minuten ab.',
    ignore: 'Hast du ihn nicht angefordert, ignoriere diese E-Mail. Ohne den Code kann sich niemand anmelden.',
    footerBrand: 'MailVault von Graphic Meat',
  },
  'fr': {
    subject: 'Votre code de connexion MailVault',
    heading: 'Votre code de connexion',
    intro: 'Saisissez ce code dans MailVault pour vous connecter à Premium.',
    autofill: 'Si MailVault est ouvert, il saisit le code pour vous.',
    heroAlt: 'Une enveloppe scellée envoie une clé à un ordinateur, qui se déverrouille.',
    expires: 'Le code ne sert qu\'une fois et expire dans 10 minutes.',
    ignore: 'Si vous ne l\'avez pas demandé, ignorez cet e-mail. Personne ne peut se connecter sans le code.',
    footerBrand: 'MailVault par Graphic Meat',
  },
  'es': {
    subject: 'Tu código de acceso de MailVault',
    heading: 'Tu código de acceso',
    intro: 'Introduce este código en MailVault para iniciar sesión en Premium.',
    autofill: 'Si MailVault está abierto, rellena el código por ti.',
    heroAlt: 'Un sobre sellado envía una llave a un ordenador, que se desbloquea.',
    expires: 'El código sirve una sola vez y caduca en 10 minutos.',
    ignore: 'Si no lo pediste, ignora este correo. Nadie puede iniciar sesión sin el código.',
    footerBrand: 'MailVault de Graphic Meat',
  },
  'it': {
    subject: 'Il tuo codice di accesso MailVault',
    heading: 'Il tuo codice di accesso',
    intro: 'Inserisci questo codice in MailVault per accedere a Premium.',
    autofill: 'Se MailVault è aperto, inserisce il codice al posto tuo.',
    heroAlt: 'Una busta sigillata invia una chiave a un computer, che si sblocca.',
    expires: 'Il codice vale una sola volta e scade tra 10 minuti.',
    ignore: 'Se non l\'hai richiesto, ignora questa e-mail. Senza il codice nessuno può accedere.',
    footerBrand: 'MailVault di Graphic Meat',
  },
  'ja': {
    subject: 'MailVaultのログインコード',
    heading: 'ログインコード',
    intro: 'MailVaultにこのコードを入力して、Premiumにログインしてください。',
    autofill: 'MailVaultを開いていれば、コードは自動で入力されます。',
    heroAlt: '封をした封筒が鍵をコンピューターに届け、ロックが解除されます。',
    expires: 'コードは1回のみ有効で、10分で期限切れになります。',
    ignore: '心当たりがない場合は、このメールを無視してください。コードがなければ誰もログインできません。',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'ko': {
    subject: 'MailVault 로그인 코드',
    heading: '로그인 코드',
    intro: 'MailVault에 이 코드를 입력해 Premium에 로그인하세요.',
    autofill: 'MailVault가 열려 있으면 코드가 자동으로 입력됩니다.',
    heroAlt: '봉인된 봉투가 컴퓨터로 열쇠를 보내 잠금이 풀립니다.',
    expires: '코드는 한 번만 사용할 수 있고 10분 후에 만료됩니다.',
    ignore: '요청하지 않으셨다면 이 이메일을 무시하세요. 코드가 없으면 아무도 로그인할 수 없습니다.',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'zh': {
    subject: '你的 MailVault 登录验证码',
    heading: '你的登录验证码',
    intro: '在 MailVault 中输入此验证码即可登录 Premium。',
    autofill: '如果 MailVault 已打开，它会自动帮你填写验证码。',
    heroAlt: '一封密封的信把钥匙送到电脑，电脑随即解锁。',
    expires: '验证码只能使用一次，10 分钟后失效。',
    ignore: '如果不是你本人请求的，请忽略这封邮件。没有验证码，任何人都无法登录。',
    footerBrand: 'MailVault，Graphic Meat 出品',
  },
  'pt-br': {
    subject: 'Seu código de acesso do MailVault',
    heading: 'Seu código de acesso',
    intro: 'Digite este código no MailVault para entrar no Premium.',
    autofill: 'Se o MailVault estiver aberto, ele preenche o código para você.',
    heroAlt: 'Um envelope lacrado envia uma chave para um computador, que é desbloqueado.',
    expires: 'O código vale uma única vez e expira em 10 minutos.',
    ignore: 'Se você não pediu, ignore este e-mail. Ninguém consegue entrar sem o código.',
    footerBrand: 'MailVault da Graphic Meat',
  },
};

// Light first (most clients ignore the dark media query); the query repaints for those that honour it.
const C = {
  page: '#f3f4f9', card: '#ffffff', ink: '#1c1d29', muted: '#5f6372', line: '#e3e5ee',
  brand: '#5b5cf0', brandInk: '#3b3db8', codeBg: '#f0f1ff', codeLine: '#cfd2ff', hero: '#0e0d12',
};
// Two pictures, both static files on our own site and the same for every mail (nothing per
// reader in the URL): the app icon beside the name, and the illustration.
const ICON_URL = 'https://mailvaultapp.com/assets/email/mailvault-icon.png';
const HERO_URL = 'https://mailvaultapp.com/assets/email/signin-code.jpg';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

function buildSigninCodeEmail(lang, code) {
  const locale = resolveLocale(lang);
  const t = COPY[locale];
  const e = escapeHtml;
  const text = [t.heading, '', t.intro, t.autofill, '', code, '', t.expires, '', '--', t.ignore, t.footerBrand, ''].join('\n');
  // The code is spaced with letter-spacing, which also pads its right edge: the same left padding keeps it centred.
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
  @media only screen and (max-width: 520px) {
    .mv-outer { padding: 20px 10px !important; }
    .mv-body { padding: 24px 20px 22px !important; }
    .mv-h1 { font-size: 20px !important; }
    .mv-code { font-size: 28px !important; letter-spacing: 6px !important; padding-left: 6px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .mv-page { background-color: #101119 !important; }
    .mv-card { background-color: #1b1c27 !important; border-color: #2e3040 !important; }
    .mv-ink { color: #f2f2f7 !important; }
    .mv-muted { color: #a9adbd !important; }
    .mv-code { background-color: #23244a !important; border-color: #3d3f7a !important; color: #e4e5ff !important; }
    .mv-rule { border-color: #2e3040 !important; }
    .mv-brand { color: #b3b5ff !important; }
  }
</style>
</head>
<body class="mv-page" style="margin:0;padding:0;background-color:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${e(t.expires)}</div>
<table role="presentation" class="mv-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td class="mv-outer" align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
  <tr><td style="padding:0 4px 14px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="font-size:0;line-height:0;"><img src="${ICON_URL}" width="28" height="28" alt="" style="display:block;width:28px;height:28px;border:0;"></td>
      <td class="mv-brand" valign="middle" style="padding-left:8px;font-family:${FONT};font-size:17px;font-weight:700;letter-spacing:-0.01em;color:${C.brandInk};">MailVault</td>
    </tr></table>
  </td></tr>
  <tr><td>
    <table role="presentation" class="mv-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:100%;background-color:${C.card};border:1px solid ${C.line};border-radius:16px;border-collapse:separate;overflow:hidden;">
    <tr><td bgcolor="${C.hero}" style="background-color:${C.hero};border-radius:15px 15px 0 0;font-size:0;line-height:0;">
      <img src="${HERO_URL}" width="520" alt="${e(t.heroAlt)}" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:15px 15px 0 0;color:#d9d6e6;font-family:${FONT};font-size:13px;line-height:1.4;">
    </td></tr>
    <tr><td class="mv-body" style="padding:30px 32px 28px;font-family:${FONT};">
      <h1 class="mv-ink mv-h1" style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:700;color:${C.ink};">${e(t.heading)}</h1>
      <p class="mv-ink" style="margin:0 0 4px;font-size:15px;line-height:1.6;color:${C.ink};">${e(t.intro)}</p>
      <p class="mv-muted" style="margin:0 0 24px;font-size:15px;line-height:1.6;color:${C.muted};">${e(t.autofill)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td class="mv-code" align="center" bgcolor="${C.codeBg}" style="padding:18px 0 18px 10px;border:1px solid ${C.codeLine};border-radius:12px;background-color:${C.codeBg};font-family:${MONO};font-size:34px;line-height:1.2;font-weight:700;letter-spacing:10px;color:${C.brandInk};white-space:nowrap;">${e(code)}</td>
      </tr></table>
      <p class="mv-muted" style="margin:16px 0 0;font-size:13px;line-height:1.6;color:${C.muted};text-align:center;">${e(t.expires)}</p>
      <hr class="mv-rule" style="margin:28px 0 20px;border:0;border-top:1px solid ${C.line};">
      <p class="mv-muted" style="margin:0;font-size:13px;line-height:1.6;color:${C.muted};">${e(t.ignore)}</p>
    </td></tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:18px 10px 0;font-family:${FONT};">
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

module.exports = { COPY, buildSigninCodeEmail };
