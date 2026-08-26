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
  ],
  theme: {
    extend: {
      colors: {
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
