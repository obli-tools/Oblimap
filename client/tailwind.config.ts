import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // All colors use CSS custom properties so themes can swap them at runtime.
        // CSS vars hold space-separated RGB triplets so Tailwind's opacity modifier
        // syntax (e.g. bg-accent/30) works correctly.
        bg: {
          primary:   'rgb(var(--c-bg-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-bg-secondary) / <alpha-value>)',
          tertiary:  'rgb(var(--c-bg-tertiary)  / <alpha-value>)',
          hover:     'rgb(var(--c-bg-hover)     / <alpha-value>)',
          active:    'rgb(var(--c-bg-active)    / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--c-border)       / <alpha-value>)',
          light:   'rgb(var(--c-border-light) / <alpha-value>)',
        },
        text: {
          primary:   'rgb(var(--c-text-primary)   / <alpha-value>)',
          secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
          muted:     'rgb(var(--c-text-muted)     / <alpha-value>)',
        },
        status: {
          up:                'rgb(var(--c-status-up)              / <alpha-value>)',
          'up-bg':           'rgb(var(--c-status-up-bg)           / <alpha-value>)',
          down:              'rgb(var(--c-status-down)            / <alpha-value>)',
          'down-bg':         'rgb(var(--c-status-down-bg)         / <alpha-value>)',
          pending:           'rgb(var(--c-status-pending)         / <alpha-value>)',
          'pending-bg':      'rgb(var(--c-status-pending-bg)      / <alpha-value>)',
          maintenance:       'rgb(var(--c-status-maintenance)     / <alpha-value>)',
          'maintenance-bg':  'rgb(var(--c-status-maintenance-bg)  / <alpha-value>)',
          paused:            'rgb(var(--c-status-paused)          / <alpha-value>)',
          'paused-bg':       'rgb(var(--c-status-paused-bg)       / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--c-accent)       / <alpha-value>)',
          hover:   'rgb(var(--c-accent-hover) / <alpha-value>)',
          dark:    'rgb(var(--c-accent-dark)  / <alpha-value>)',
        },
        // Alias used by enrollment wizard and interactive components
        primary: 'rgb(var(--c-primary) / <alpha-value>)',
      },
      fontFamily: {
        // Two-tier stack.
        // - sans:    body, nav, table rows, form fields
        // - display: page titles, hero KPIs (≥ 24 px). Opt-in via class.
        // - mono:    counts, IDs, timestamps, version strings
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Noto Sans',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        display: [
          'Rajdhani',
          'Inter',
          '-apple-system',
          'Segoe UI',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      // Sheet / drawer entrance animations used by components/common/Modal
      // and Drawer (ported from Obliance). Opt-in classes only.
      keyframes: {
        'obli-fade-in':        { from: { opacity: '0' }, to: { opacity: '1' } },
        'obli-slide-in-left':  { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'obli-slide-in-right': { from: { transform: 'translateX(100%)' },  to: { transform: 'translateX(0)' } },
        'obli-slide-in-up':    { from: { transform: 'translateY(100%)' },  to: { transform: 'translateY(0)' } },
      },
      animation: {
        'obli-fade-in':        'obli-fade-in 150ms ease-out',
        'obli-slide-in-left':  'obli-slide-in-left 200ms ease-out',
        'obli-slide-in-right': 'obli-slide-in-right 200ms ease-out',
        'obli-slide-in-up':    'obli-slide-in-up 200ms ease-out',
      },
    },
  },
  plugins: [
    // Input-capability variants (ported from Obliance tailwind.config.ts):
    //   coarse:     → @media (pointer: coarse)          (touch: bigger targets)
    //   can-hover:  → @media (hover: hover) and (pointer: fine)
    //                 (things that must only exist with a mouse)
    // Plugin variants rather than `theme.screens` raw entries on purpose:
    // object screens make Tailwind disable every `max-*` / `min-*` variant.
    // Default breakpoints are untouched.
    plugin(({ addVariant }) => {
      addVariant('coarse', '@media (pointer: coarse)');
      addVariant('can-hover', '@media (hover: hover) and (pointer: fine)');
    }),
  ],
} satisfies Config;
