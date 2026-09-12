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
        canvas:   '#06142B',
        primary:  '#081A38',
        depth:    '#040E22',
        s1:       '#14315E',
        s2:       '#0D2449',
        s3:       '#0A1F3F',
        act:      '#1E88FF',
        'act-hov':'#4BA0FF',
        'act-dim':'#1B4A85',
        acc:      '#7DBBFF',
        glow:     '#A9D3FF',
        t1:       '#F2F5FA',
        t2:       '#B8C7E0',
        t3:       '#7F94B4',
        bd1:      '#264472',
        bd2:      '#183258',
        ok:       '#4ADE80',
        warn:     '#FFC107',
        err:      '#F87171',
        'err-solid': '#DC2626',
        info:     '#4BA0FF',
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
