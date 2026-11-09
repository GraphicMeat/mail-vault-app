# Locale folders

Folder names are the app's catalog codes (`src/i18n/locales`). Upload mapping:

| Folder | App Store Connect locale | Play Console language |
|---|---|---|
| en | English (U.S.) | English (United States) en-US |
| de | German | German de-DE |
| es | Spanish (Spain) | Spanish (Spain) es-ES |
| fr | French | French fr-FR |
| it | Italian | Italian it-IT |
| ja | Japanese | Japanese ja-JP |
| ko | Korean | Korean ko-KR |
| pt-BR | Portuguese (Brazil) | Portuguese (Brazil) pt-BR |
| zh-Hans | Chinese (Simplified) | Chinese, Simplified zh-CN |

Limits (checked by `store/__tests__/listings.test.js`): App Store name 30, subtitle 30, keywords 100, promotional text 170, description 4000. Play title 30, short 80, full 4000. Counts are characters.

The copy says new-mail notifications arrive roughly every 15 minutes at best (the system decides), that mail stays on the phone and the user's mail server, and names no price. Prices come from the store product data, never from the listing. No web price, no web checkout link, no "open source".
