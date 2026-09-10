import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      // Obsidian system (audit 2026-08-07 IS-10). Literal hexes (not CSS vars)
      // so Tailwind alpha modifiers (bg-act/10 …) keep working — values MUST
      // mirror the :root tokens in src/app/globals.css.
      colors: {
        canvas:   '#07090D',
        primary:  '#0B0E14',
        depth:    '#05070A',
        s1:       '#171C26',
        s2:       '#10141C',
        s3:       '#0D1119',
        act:      '#5B8DEF',
        'act-hov':'#7CA5F4',
        'act-dim':'#31446E',
        acc:      '#8FB0F7',
        glow:     '#A9C5FF',
        t1:       '#F2F4F8',
        t2:       '#B7C0CE',
        t3:       '#8B95A8',
        bd1:      '#2A3140',
        bd2:      '#1C2230',
        ok:       '#4ADE80',
        warn:     '#FFC107',
        err:      '#F87171',
        'err-solid': '#DC2626',
        info:     '#7CA5F4',
      },
      keyframes: {
        pulse: { '50%': { boxShadow: '0 0 0 4px rgba(220,38,38,0.15)' } },
        mpulse: {
          '0%': { opacity: '0.8', transform: 'scale(0.8)' },
          '100%': { opacity: '0', transform: 'scale(2.2)' },
        },
      },
      animation: {
        pulse:  'pulse 2s ease-in-out infinite',
        mpulse: 'mpulse 2.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
