# Terms of Use (EULA) for the stores

The app links its Terms of Use on the paywall (`src/mobile/Premium.jsx`, `TERMS_URL`):

    https://mailvaultapp.com/terms.html

and the Privacy Policy (`PRIVACY_URL`):

    https://mailvaultapp.com/privacy.html

- App Store Connect: leave the standard Apple Licensed Application EULA, and put the Terms of Use link in the App Description (every `store/apple/<locale>/description.txt` already ends with both links). If the owner prefers a custom EULA, paste the text of the terms page into App Information > License Agreement and keep the same URL here.
- Play Console: no EULA field. The links are in `full_description.txt` and in the app.
- Keep this file, the paywall constant and the listing links on the same URL. `store/__tests__/listings.test.js` checks the listing side.
