// The files Tailwind reads for the phone bundle's classes (vite.mobile.config.js): the phone's
// entry page and every directory or file of desktop's that src/mobile/main.jsx reaches, not all of
// src/, so desktop-only classes stay out of the phone's CSS. A guard
// (src/mobile/__tests__/tailwindContent.test.js) checks every module the phone bundle reaches is
// covered, so a new shared directory cannot silently lose its classes.
export const MOBILE_TAILWIND_CONTENT = Object.freeze([
  './mobile.html',
  './src/mobile/**/*.{js,jsx}',
  './src/components/settings/views/**/*.{js,jsx}',
  './src/components/settings/settingsManifest.js',
  './src/components/ui/**/*.{js,jsx}',
  './src/components/tags/**/*.{js,jsx}',
  './src/components/fields/**/*.{js,jsx}',
  './src/components/transfer/**/*.{js,jsx}',
  './src/components/ViewIcon.jsx',
  './src/utils/**/*.{js,jsx}',
  './src/shared/**/*.{js,jsx}',
  './src/data/**/*.{js,jsx}',
  './src/services/appLink.js',
  './src/services/faqUrl.js',
  './src/i18n/core.js',
  './src/i18n/languages.js',
]);
