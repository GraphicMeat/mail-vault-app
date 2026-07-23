// mail-* palette lives as CSS vars in src/styles/index.css. Registering the
// colors here (as alpha-aware closures) makes Tailwind opacity modifiers like
// bg-mail-accent/10 actually generate CSS — the hand-written utility classes
// in index.css don't support them.
const mailColor = (name) => ({ opacityValue }) =>
  opacityValue === undefined || opacityValue === '1'
    ? `var(--mail-${name})`
    : `color-mix(in srgb, var(--mail-${name}) calc(${opacityValue} * 100%), transparent)`

const mailColors = Object.fromEntries(
  [
    'accent', 'accent-hover', 'bg', 'border', 'danger', 'input-bg', 'local',
    'server', 'success', 'surface', 'surface-hover', 'text', 'text-muted', 'warning',
  ].map((name) => [`mail-${name}`, mailColor(name)])
)

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: mailColors,
      fontFamily: {
        'display': ['Instrument Sans', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace']
      },
      animation: {
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'slide-in': 'slide-in 0.3s ease-out',
        'fade-in': 'fade-in 0.2s ease-out'
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.7 }
        },
        'slide-in': {
          '0%': { transform: 'translateX(-10px)', opacity: 0 },
          '100%': { transform: 'translateX(0)', opacity: 1 }
        },
        'fade-in': {
          '0%': { opacity: 0 },
          '100%': { opacity: 1 }
        }
      }
    },
  },
  plugins: [],
}
