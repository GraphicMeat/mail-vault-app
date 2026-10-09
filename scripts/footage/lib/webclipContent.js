/**
 * What the website clips type, create and look for, per app locale: the parts
 * of a take that are the clip's own content, not the app's UI and not the demo
 * mailbox (those already follow FOOTAGE_LOCALE). English is the reference and
 * the fallback; bulk mail lists (history, extra mail) deliberately stay English
 * like a real mixed-language inbox. Native review of the translations is open.
 *
 *   custom-fields   field and choice names the take seeds through `fields.save`
 *   ai-writing      the rough paragraph and subject typed off camera
 *   tagging-rules   tag name, rule wordings, the invoice delivered over IMAP, bill words
 *   templates       template name, body, subject
 *   tags            the local label added by hand
 */

const en = {
  customFields: { stage: 'Stage', review: 'Review', approved: 'Approved', paid: 'Paid', followUp: 'Follow up', owner: 'Owner' },
  aiWriting: {
    subject: 'Box sleeves',
    rough: 'Hi Theo, just checking in to see if there is any chance at all that the box sleeves could be ready by Thursday, '
      + 'since the client prints on Friday and we would really like to have them in hand before then. Thanks so much!',
  },
  tagging: {
    tag: 'Invoices',
    subject: 'Invoice 2026-0471 for the October print run',
    wordings: ['Invoices and bills', 'Invoices, bills and receipts from suppliers', 'Bank statements and invoices I need to pay or file'],
    body: ['Hi Rowan,', '', 'Attached is the invoice for the October print run: 2,400 box sleeves.', 'Payment is due in 14 days.', '', 'Skewer Print'],
    billWords: 'invoice|bill|receipt|statement|payment',
  },
  templates: {
    name: 'Print quote',
    subject: 'Box sleeves quote',
    body: 'Thanks for the brief. For 2,400 box sleeves on 350 gsm board the price is 1,180 EUR, ready in eight working days.',
  },
  tags: { tag: 'Receipts' },
  // Words that date a screen (scanText): "N days ago" in the locale.
  ago: ['\\b\\d+\\s*(days?|weeks?|months?|years?)\\s+ago\\b'],
};

const BY_LOCALE = {
  en,
  de: {
    customFields: { stage: 'Phase', review: 'Prüfung', approved: 'Freigegeben', paid: 'Bezahlt', followUp: 'Nachfassen', owner: 'Zuständig' },
    aiWriting: {
      subject: 'Banderolen',
      rough: 'Hallo Theo, ich wollte nur kurz nachfragen, ob es vielleicht irgendeine Chance gibt, dass die Banderolen bis Donnerstag fertig sind, '
        + 'weil der Kunde am Freitag druckt und wir sie wirklich gern vorher in den Händen hätten. Vielen Dank!',
    },
    tagging: {
      tag: 'Rechnungen',
      subject: 'Rechnung 2026-0471 für den Oktober-Druckauftrag',
      wordings: ['Rechnungen und Zahlungsaufforderungen', 'Rechnungen, Belege und Quittungen von Lieferanten', 'Kontoauszüge und Rechnungen, die ich bezahlen oder ablegen muss'],
      body: ['Hallo Rowan,', '', 'anbei die Rechnung für den Oktober-Druckauftrag: 2.400 Banderolen.', 'Zahlbar innerhalb von 14 Tagen.', '', 'Skewer Print'],
      billWords: 'rechnung|beleg|quittung|kontoauszug|zahlung',
    },
    templates: {
      name: 'Druckangebot',
      subject: 'Angebot Banderolen',
      body: 'Danke für das Briefing. Für 2.400 Banderolen auf 350-g-Karton beträgt der Preis 1.180 EUR, lieferbar in acht Werktagen.',
    },
    tags: { tag: 'Belege' },
    ago: ['\\bvor\\s+\\d+\\s+(Tag|Tagen|Woche|Wochen|Monat|Monaten|Jahr|Jahren)\\b'],
  },
  es: {
    customFields: { stage: 'Fase', review: 'Revisión', approved: 'Aprobado', paid: 'Pagado', followUp: 'Seguimiento', owner: 'Responsable' },
    aiWriting: {
      subject: 'Fundas para cajas',
      rough: 'Hola Theo, solo quería preguntarte si hay alguna posibilidad de que las fundas para las cajas estén listas para el jueves, '
        + 'ya que el cliente imprime el viernes y nos gustaría de verdad tenerlas en la mano antes. ¡Muchas gracias!',
    },
    tagging: {
      tag: 'Facturas',
      subject: 'Factura 2026-0471 del pedido de impresión de octubre',
      wordings: ['Facturas y recibos', 'Facturas, recibos y cobros de proveedores', 'Extractos bancarios y facturas que tengo que pagar o archivar'],
      body: ['Hola Rowan,', '', 'Adjunto la factura del pedido de impresión de octubre: 2.400 fundas para cajas.', 'El pago vence en 14 días.', '', 'Skewer Print'],
      billWords: 'factura|recibo|extracto|pago|cobro',
    },
    templates: {
      name: 'Presupuesto de impresión',
      subject: 'Presupuesto fundas para cajas',
      body: 'Gracias por el briefing. Para 2.400 fundas para cajas en cartulina de 350 g el precio es de 1.180 EUR, listas en ocho días laborables.',
    },
    tags: { tag: 'Recibos' },
    ago: ['\\bhace\\s+\\d+\\s+(d[ií]as?|semanas?|mes(es)?|años?)\\b'],
  },
  fr: {
    customFields: { stage: 'Étape', review: 'Relecture', approved: 'Approuvé', paid: 'Payé', followUp: 'À relancer', owner: 'Responsable' },
    aiWriting: {
      subject: 'Fourreaux',
      rough: 'Bonjour Theo, je voulais juste savoir s’il y a une chance que les fourreaux soient prêts pour jeudi, '
        + 'puisque le client imprime vendredi et que nous aimerions vraiment les avoir en main avant. Merci beaucoup !',
    },
    tagging: {
      tag: 'Factures',
      subject: 'Facture 2026-0471 pour le tirage d’octobre',
      wordings: ['Factures et notes à payer', 'Factures, notes et reçus des fournisseurs', 'Relevés bancaires et factures que je dois payer ou classer'],
      body: ['Bonjour Rowan,', '', 'Veuillez trouver ci-joint la facture du tirage d’octobre : 2 400 fourreaux.', 'Paiement à 14 jours.', '', 'Skewer Print'],
      billWords: 'facture|reçu|relevé|paiement|note',
    },
    templates: {
      name: 'Devis d’impression',
      subject: 'Devis fourreaux',
      body: 'Merci pour le brief. Pour 2 400 fourreaux sur carton de 350 g, le prix est de 1 180 EUR, livrables en huit jours ouvrés.',
    },
    tags: { tag: 'Reçus' },
    ago: ['\\bil y a\\s+\\d+\\s+(jours?|semaines?|mois|ans?)\\b'],
  },
  it: {
    customFields: { stage: 'Fase', review: 'Revisione', approved: 'Approvato', paid: 'Pagato', followUp: 'Da sollecitare', owner: 'Responsabile' },
    aiWriting: {
      subject: 'Fascette per scatole',
      rough: 'Ciao Theo, volevo solo sapere se c’è qualche possibilità che le fascette per le scatole siano pronte entro giovedì, '
        + 'visto che il cliente stampa venerdì e ci piacerebbe davvero averle in mano prima. Grazie mille!',
    },
    tagging: {
      tag: 'Fatture',
      subject: 'Fattura 2026-0471 per la stampa di ottobre',
      wordings: ['Fatture e conti da pagare', 'Fatture, conti e ricevute dei fornitori', 'Estratti conto e fatture che devo pagare o archiviare'],
      body: ['Ciao Rowan,', '', 'in allegato la fattura per la stampa di ottobre: 2.400 fascette per scatole.', 'Il pagamento è dovuto entro 14 giorni.', '', 'Skewer Print'],
      billWords: 'fattura|ricevuta|estratto|pagamento|conto',
    },
    templates: {
      name: 'Preventivo di stampa',
      subject: 'Preventivo fascette',
      body: 'Grazie per il brief. Per 2.400 fascette per scatole su cartoncino da 350 g il prezzo è di 1.180 EUR, pronte in otto giorni lavorativi.',
    },
    tags: { tag: 'Ricevute' },
    ago: ['\\b\\d+\\s+(giorni|settimane|mesi|anni|giorno|settimana|mese|anno)\\s+fa\\b'],
  },
  ja: {
    customFields: { stage: '段階', review: '確認中', approved: '承認済み', paid: '支払い済み', followUp: 'フォローアップ', owner: '担当者' },
    aiWriting: {
      subject: '箱用スリーブ',
      rough: 'Theoさん、お疲れさまです。箱用スリーブのことでご相談ですが、お客様が金曜日に印刷されるため、できれば木曜日までに仕上げていただくことは可能でしょうか。'
        + 'その前にぜひ手元に届けたいと思っております。どうぞよろしくお願いいたします。',
    },
    tagging: {
      tag: '請求書',
      subject: '請求書 2026-0471(10月分の印刷)',
      wordings: ['請求書と支払いのご案内', '取引先からの請求書や領収書', '支払いまたは保管が必要な銀行明細と請求書'],
      body: ['Rowanさん、', '', '10月分の印刷の請求書を添付します。箱用スリーブ2,400枚分です。', 'お支払い期限は14日以内です。', '', 'Skewer Print'],
      billWords: '請求|領収|明細|支払|振込',
    },
    templates: {
      name: '印刷のお見積もり',
      subject: '箱用スリーブのお見積もり',
      body: 'ご依頼ありがとうございます。箱用スリーブ2,400枚(350g板紙)の価格は1,180ユーロ、納期は8営業日です。',
    },
    tags: { tag: '領収書' },
    ago: ['\\d+\\s*(日|週間|か月|ヶ月|カ月|年)前'],
  },
  ko: {
    customFields: { stage: '단계', review: '검토 중', approved: '승인됨', paid: '결제 완료', followUp: '후속 조치', owner: '담당자' },
    aiWriting: {
      subject: '박스 슬리브',
      rough: '안녕하세요 Theo, 혹시 박스 슬리브를 목요일까지 받을 수 있는 가능성이 조금이라도 있는지 여쭤보려고 연락드렸어요. '
        + '고객이 금요일에 인쇄를 하는 터라 그 전에 꼭 손에 받아 보고 싶습니다. 정말 감사합니다!',
    },
    tagging: {
      tag: '청구서',
      subject: '청구서 2026-0471 (10월 인쇄분)',
      wordings: ['청구서와 결제 안내', '거래처 청구서와 영수증', '결제하거나 보관해야 하는 은행 명세서와 청구서'],
      body: ['Rowan님,', '', '10월 인쇄분 청구서를 첨부합니다. 박스 슬리브 2,400개분입니다.', '결제 기한은 14일 이내입니다.', '', 'Skewer Print'],
      billWords: '청구|영수|명세|결제|납부',
    },
    templates: {
      name: '인쇄 견적',
      subject: '박스 슬리브 견적',
      body: '의뢰해 주셔서 감사합니다. 350g 판지 박스 슬리브 2,400개의 가격은 1,180 EUR이며 영업일 기준 8일 내 납품 가능합니다.',
    },
    tags: { tag: '영수증' },
    ago: ['\\d+\\s*(일|주|개월|달|년)\\s*전'],
  },
  'pt-BR': {
    customFields: { stage: 'Etapa', review: 'Revisão', approved: 'Aprovado', paid: 'Pago', followUp: 'Acompanhar', owner: 'Responsável' },
    aiWriting: {
      subject: 'Cintas para caixas',
      rough: 'Oi Theo, tudo bem? Só queria saber, sem querer apressar ninguém, se existe alguma chance, por menor que seja, de as cintas para as caixas '
        + 'ficarem prontas até quinta-feira, já que o cliente imprime na sexta e a gente gostaria muito, muito mesmo, de tê-las em mãos antes disso. '
        + 'Se não for possível, me avisa, por favor. Muito obrigado!',
    },
    tagging: {
      tag: 'Faturas',
      subject: 'Fatura 2026-0471 da impressão de outubro',
      wordings: ['Faturas e boletos', 'Faturas, boletos e recibos de fornecedores', 'Extratos bancários e faturas que preciso pagar ou arquivar'],
      body: ['Oi Rowan,', '', 'Segue a fatura da impressão de outubro: 2.400 cintas para caixas.', 'O pagamento vence em 14 dias.', '', 'Skewer Print'],
      billWords: 'fatura|boleto|recibo|extrato|pagamento',
    },
    templates: {
      name: 'Orçamento de impressão',
      subject: 'Orçamento das cintas',
      body: 'Obrigado pelo briefing. Para 2.400 cintas para caixas em cartão de 350 g, o preço é de 1.180 EUR, prontas em oito dias úteis.',
    },
    tags: { tag: 'Recibos' },
    ago: ['\\bh[áa]\\s+\\d+\\s+(dias?|semanas?|mes(es)?|anos?)\\b'],
  },
  'zh-Hans': {
    customFields: { stage: '阶段', review: '审核中', approved: '已批准', paid: '已付款', followUp: '待跟进', owner: '负责人' },
    aiWriting: {
      subject: '盒套',
      rough: 'Theo 你好，想问一下盒套有没有可能在周四前做好，因为客户周五要印刷，我们真的很希望在那之前拿到手。非常感谢！',
    },
    tagging: {
      tag: '发票',
      subject: '发票 2026-0471(10月印刷)',
      wordings: ['发票和账单', '供应商的发票、账单和收据', '需要支付或归档的银行对账单和发票'],
      body: ['Rowan 你好，', '', '附上 10 月印刷的发票：盒套 2,400 个。', '请在 14 天内付款。', '', 'Skewer Print'],
      billWords: '发票|账单|收据|对账|付款',
    },
    templates: {
      name: '印刷报价',
      subject: '盒套报价',
      body: '感谢您的需求说明。2,400 个 350 克卡纸盒套的价格为 1,180 欧元，8 个工作日内交付。',
    },
    tags: { tag: '收据' },
    ago: ['\\d+\\s*(天|周|个月|年)前'],
  },
};

/** The content of one app locale; any group a locale lacks falls back to English. */
export function webclipContent(appLocale) {
  const own = BY_LOCALE[appLocale] || {};
  return Object.fromEntries(Object.keys(en).map((k) => [k, own[k] ?? en[k]]));
}

/** Regex sources for a date as the app prints it in `appLocale` (a clip must not carry the day it was shot). */
export function todayPatterns(appLocale, d = new Date()) {
  const day = d.getDate(), y = d.getFullYear(), mm = d.getMonth() + 1;
  const p2 = (n) => String(n).padStart(2, '0');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new Set();
  for (const loc of [appLocale, 'en-US']) {
    for (const month of ['long', 'short']) {
      try { names.add(esc(d.toLocaleString(loc, { month }).replace(/\.$/, ''))); } catch { /* unknown locale */ }
    }
  }
  const mon = [...names].filter(Boolean).join('|');
  return [
    `(${mon})\\.?\\s*${day}\\b(?!:)`, `\\b${day}\\.?\\s*(de\\s+|del\\s+|d['’]\\s*)?(${mon})`,
    `\\b${y}-${p2(mm)}-${p2(day)}\\b`, `\\b${mm}/${day}/(${y}|${String(y).slice(2)})\\b`, `\\b${p2(day)}\\.${p2(mm)}\\.${y}\\b`,
    `\\b${day}/${mm}/${y}\\b`, `\\b${p2(day)}/${p2(mm)}/${y}\\b`, `${y}[/.年]\\s*0?${mm}[/.月]\\s*0?${day}\\b`, `${mm}月\\s*${day}日`, `${mm}월\\s*${day}일`,
    ...webclipContent(appLocale).ago,
  ];
}
