/** Tailwind config for the marketing site (mailvaultapp.com).
 *  Mirrors the inline `tailwind.config` blocks the CDN build used to carry on
 *  every page. Build with `npm run build:website-css` from the repo root. */
export default {
  darkMode: 'class',
  content: [
    './**/*.html',
    './pricing-localize.js',
    '!./node_modules/**',
    '!./api/**',
    // Generated locale copies only ever carry classes their English source
    // already had, so scanning 300+ of them buys nothing and costs build time.
    '!./{de,fr,es,it,pt-br,ja,ko,zh}/**',
  ],
  theme: {
    extend: {
      colors: {
        // Custody — the same closed vocabulary the client uses. Emerald says
        // a message is on your disk, blue says it is on the server, gold says
        // the server no longer has it. The site teaches this palette before
        // anyone downloads; it is never spent on decoration here either.
        vault: {
          50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7',
          400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857',
          800: '#065f46', 900: '#064e3b',
        },
        server: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
          400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
          800: '#1e40af', 900: '#1e3a8a',
        },
        onlycopy: {
          50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d',
          400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309',
          800: '#92400e', 900: '#78350f',
        },
        primary: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
      },
      fontFamily: {
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
}
