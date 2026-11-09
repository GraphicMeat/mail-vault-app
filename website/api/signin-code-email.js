// The mail that carries a phone sign-in code (signin-code.js). Pure functions,
// nine locales shared with the email-me-the-link mail. Nothing the requester
// typed reaches the body except the code we generated: no links, no remote
// images, no tracking, and the code is not in the subject line.
const { LOCALES, resolveLocale, escapeHtml } = require('./send-link-email');

const COPY = {
  'en': {
    subject: 'Your MailVault sign-in code',
    heading: 'Your sign-in code',
    intro: 'Enter this code in MailVault on your phone to unlock Premium.',
    expires: 'The code works once and expires in 10 minutes.',
    ignore: 'If you did not ask for it, ignore this email. Nobody can sign in without the code.',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'de': {
    subject: 'Dein MailVault-Anmeldecode',
    heading: 'Dein Anmeldecode',
    intro: 'Gib diesen Code in MailVault auf deinem Handy ein, um Premium freizuschalten.',
    expires: 'Der Code gilt einmal und läuft in 10 Minuten ab.',
    ignore: 'Hast du ihn nicht angefordert, ignoriere diese E-Mail. Ohne den Code kann sich niemand anmelden.',
    footerBrand: 'MailVault von Graphic Meat',
  },
  'fr': {
    subject: 'Votre code de connexion MailVault',
    heading: 'Votre code de connexion',
    intro: 'Saisissez ce code dans MailVault sur votre téléphone pour débloquer Premium.',
    expires: 'Le code ne sert qu\'une fois et expire dans 10 minutes.',
    ignore: 'Si vous ne l\'avez pas demandé, ignorez cet e-mail. Personne ne peut se connecter sans le code.',
    footerBrand: 'MailVault par Graphic Meat',
  },
  'es': {
    subject: 'Tu código de acceso de MailVault',
    heading: 'Tu código de acceso',
    intro: 'Introduce este código en MailVault en tu teléfono para desbloquear Premium.',
    expires: 'El código sirve una sola vez y caduca en 10 minutos.',
    ignore: 'Si no lo pediste, ignora este correo. Nadie puede iniciar sesión sin el código.',
    footerBrand: 'MailVault de Graphic Meat',
  },
  'it': {
    subject: 'Il tuo codice di accesso MailVault',
    heading: 'Il tuo codice di accesso',
    intro: 'Inserisci questo codice in MailVault sul telefono per sbloccare Premium.',
    expires: 'Il codice vale una sola volta e scade tra 10 minuti.',
    ignore: 'Se non l\'hai richiesto, ignora questa e-mail. Senza il codice nessuno può accedere.',
    footerBrand: 'MailVault di Graphic Meat',
  },
  'ja': {
    subject: 'MailVaultのログインコード',
    heading: 'ログインコード',
    intro: 'スマートフォンのMailVaultにこのコードを入力すると、Premiumが使えるようになります。',
    expires: 'コードは1回のみ有効で、10分で期限切れになります。',
    ignore: '心当たりがない場合は、このメールを無視してください。コードがなければ誰もログインできません。',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'ko': {
    subject: 'MailVault 로그인 코드',
    heading: '로그인 코드',
    intro: '휴대폰의 MailVault에 이 코드를 입력하면 Premium을 사용할 수 있습니다.',
    expires: '코드는 한 번만 사용할 수 있고 10분 후에 만료됩니다.',
    ignore: '요청하지 않으셨다면 이 이메일을 무시하세요. 코드가 없으면 아무도 로그인할 수 없습니다.',
    footerBrand: 'MailVault by Graphic Meat',
  },
  'zh': {
    subject: '你的 MailVault 登录验证码',
    heading: '你的登录验证码',
    intro: '在手机上的 MailVault 中输入此验证码即可解锁 Premium。',
    expires: '验证码只能使用一次，10 分钟后失效。',
    ignore: '如果不是你本人请求的，请忽略这封邮件。没有验证码，任何人都无法登录。',
    footerBrand: 'MailVault，Graphic Meat 出品',
  },
  'pt-br': {
    subject: 'Seu código de acesso do MailVault',
    heading: 'Seu código de acesso',
    intro: 'Digite este código no MailVault do seu celular para liberar o Premium.',
    expires: 'O código vale uma única vez e expira em 10 minutos.',
    ignore: 'Se você não pediu, ignore este e-mail. Ninguém consegue entrar sem o código.',
    footerBrand: 'MailVault da Graphic Meat',
  },
};

const C = { page: '#eef0f7', card: '#ffffff', ink: '#20212c', muted: '#575b69', line: '#d9dce6', brand: '#6366f1', soft: '#f5f5ff' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function buildSigninCodeEmail(lang, code) {
  const locale = resolveLocale(lang);
  const t = COPY[locale];
  const e = escapeHtml;
  const text = [t.heading, '', t.intro, '', code, '', t.expires, '', '--', t.ignore, t.footerBrand, ''].join('\n');
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
    .mv-soft { background-color: #24253a !important; }
    .mv-brand { color: #a5a8ff !important; }
  }
</style>
</head>
<body class="mv-page" style="margin:0;padding:0;background-color:${C.page};">
<table role="presentation" class="mv-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td align="center" style="padding:32px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
  <tr><td style="padding:0 8px 18px;font-family:${FONT};">
    <span class="mv-brand" style="font-size:22px;font-weight:800;letter-spacing:-0.02em;color:${C.brand};">MailVault</span>
  </td></tr>
  <tr><td>
    <table role="presentation" class="mv-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:14px;">
    <tr><td style="padding:32px 28px;font-family:${FONT};">
      <h1 class="mv-ink" style="margin:0 0 14px;font-size:24px;line-height:1.3;font-weight:700;color:${C.ink};">${e(t.heading)}</h1>
      <p class="mv-ink" style="margin:0 0 22px;font-size:16px;line-height:1.6;color:${C.ink};">${e(t.intro)}</p>
      <p class="mv-soft mv-ink" style="margin:0 0 22px;padding:16px 20px;border-radius:10px;background-color:${C.soft};text-align:center;font-size:34px;line-height:1.2;font-weight:800;letter-spacing:0.3em;color:${C.ink};">${e(code)}</p>
      <p class="mv-muted" style="margin:0;font-size:15px;line-height:1.6;color:${C.muted};">${e(t.expires)}</p>
    </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:20px 10px 0;font-family:${FONT};">
    <p class="mv-muted" style="margin:0 0 8px;font-size:12px;line-height:1.6;color:${C.muted};">${e(t.ignore)}</p>
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
