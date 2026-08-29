# Localizing mailvaultapp.com

The English HTML under `website/` is the only source of truth. Nobody edits a
translated page by hand — they are generated, and a hand edit is overwritten on
the next build.

```bash
npm run i18n          # extract + inject + build, from website/
npm run i18n:status   # translation coverage per locale
node i18n/i18n.mjs check [locale]   # validate locale files before building
```

| step | what it does |
|---|---|
| `extract` | scans the English pages, updates `i18n/corpus.json` |
| `inject`  | writes the hreflang block and footer language switcher into the English sources, in place, between markers |
| `build`   | emits `website/<lang>/**` and regenerates `sitemap.xml` |
| `chunk N` | prints one corpus chunk, for a translator to work from |
| `check`   | fails if a locale is incomplete or lost a placeholder or a tag |
| `prune`   | drops translations whose English no longer exists |
| `missing` | `missing de` lists untranslated parts, `missing de:2` prints one |
| `verify`  | checks the *generated pages*: tag sequence matches English, every link resolves |

`check` reads the locale JSON; it says nothing about `website/<lang>/`. A locale
can report `2503/2503 ok` while the built pages are still the previous run's — so
**always `build` before looking at a page**. Production is safe either way,
because the deploy regenerates, but a local preview will happily show you a stale
locale and look like a translation bug.

Locales: `de fr es it pt-br ja ko zh` (see `LOCALES` in `i18n.mjs`).
`changelog.html` is excluded because it is regenerated on every release;
`privacy.html` and `terms.html` stay authoritative in English.

## The corpus

`corpus.json` maps a chunk id to `{ <key>: "<English string>" }`. The key is a
hash of the normalized English text, so identical strings share one translation —
the nav, footer and CTAs appear on 40 pages and are translated once.

Chunk membership is **sticky**: an existing key keeps its chunk when English copy
changes, so editing one sentence does not reshuffle eight locale files. New keys
land in the last chunk until it fills.

A translation lives at `i18n/locales/<lang>/<chunk>.json` with the **same keys**
and the same chunking. A missing key falls back to English rather than leaving a
hole in the page.

## Sentences are translated whole, markup included

Inline markup mid-sentence used to produce one string per piece:

```html
<p>Stored <strong>in Maildir</strong> format on your computer.</p>
```

became `Stored` / `in Maildir` / `format on your computer.` — fragments that are
not translatable units. Their order was frozen by the markup, so Spanish rendered
the pricing hero as *"Sencillo y honesto Precios"*, and every translator had to
smuggle words across neighbouring keys to make sentences assemble. One of them was
reduced to translating the word `does` as a bare `，`.

So a **sentence container** (`p li h1-h6 td th dd dt figcaption blockquote
summary`) whose text is split by inline markup is now lifted whole, as a single
string that contains its own HTML:

```json
"Stored <strong>in Maildir</strong> format on your computer.":
  "Auf deinem Rechner <strong>im Maildir-Format</strong> gespeichert."
```

This is automatic — nothing is annotated. An element holding block-level structure
(a nested list, say) is left alone so one `<li>` cannot swallow a whole list.
`data-i18n-block` forces the treatment on an element that would not qualify.

**Translating a block string:**

- Keep exactly the same tags, the same count, and the same attribute values.
  `check` fails the locale on a tag-count mismatch.
- Never translate a `class`, an `href`, or anything inside `<code>` — those are
  literal commands and filenames.
- **Move the tags** to wherever the target language wants the emphasis. That is
  the whole point: `Precios <span class="text-primary-500">honestos</span> y
  sencillos`, not the English order preserved.

Links inside a block are re-localized after substitution, so `/faq.html` still
becomes `/de/faq.html`.

## Voice

Plain, concrete, unhyped. The English names mechanisms rather than benefits
("files every message on your own disk as a plain `.eml`", not "revolutionizes
your inbox"). Translations keep that register: no exclamation marks the English
does not have, no marketing intensifiers, no borrowed hype.

Address the reader directly, in the form that reads as ordinary in the language —
German **du**, French **vous**, Japanese **です／ます**, Korean **-습니다**.
Be consistent across the whole locale.

The audience is four kinds of person at once: someone whose mailbox is full,
someone who wants their mail on their own disk, a freelancer treating email as a
business record, and a power emailer switching clients. Copy should read as
though written for that reader in their language, not translated at them.

## Never translate

Product, company and platform names, and anything that is a literal identifier:

> MailVault · Graphic Meat · GraphicMeat · GitHub · Maildir · `.eml` · `.mbox` ·
> IMAP · SMTP · OAuth2 · MBOX · SPF · DKIM · DMARC · Gmail · Google · Outlook ·
> Microsoft 365 · iCloud · Yahoo Mail · Thunderbird · Apple Mail · MailStore ·
> Proton Bridge · macOS · Linux · Windows · Ubuntu · Debian · App Store ·
> Stripe · Sparkle · Tauri · Rust · Time Capsule · Premium

"Time Capsule" and "Premium" are MailVault feature names, not descriptions —
they stay English so they match the app's own UI. Where the surrounding sentence
needs a gloss the first time, add one in the target language after the name.

## Hard rules

- **Prices stay in USD, exactly as written.** `$4/month`, `$25/year`, `$0`.
  The static page is the canonical number and the checkout converts at runtime.
  Translate the `/month` and `/year` part, never the amount or the symbol.
- **Brace placeholders survive verbatim**: `{monthly}`, `{yearly}`,
  `{monthlyEquivalent}`, `{zero}`. Reorder the sentence around them if the
  language needs it.
- **HTML entities pass through unchanged** (`&copy;`, `&mdash;`, `&rarr;`,
  `&middot;`, `&nbsp;`). If a translation introduces a bare `&`, write `&amp;`.
- **Never add or remove markup.** A plain string is a text node or an attribute
  value; a `<` in its translation breaks the page. A block string already carries
  markup and must keep exactly the tags it came with — same tags, same count, same
  attribute values — see above.
- **Keep UI labels short.** A string that is a button or nav item in English
  ("Download", "Features", "Most Popular") has to fit the same control. Prefer
  the shortest natural word; German and Portuguese run long, so watch these.
- **Version numbers, dates, counts and file sizes stay as they are.**
- Numbers keep their digits; adapt only the separators and units the language
  genuinely writes differently.

## Adding a locale

Append an entry to `LOCALES` in `i18n.mjs` (`dir`, `hreflang`, `htmlLang`,
`ogLocale`, `name` — `name` is the language's own endonym, shown in the
switcher), create `i18n/locales/<dir>/`, translate the chunks, then
`npm run i18n`. The hreflang blocks, switcher and sitemap pick it up on the next
`inject`/`build`.
