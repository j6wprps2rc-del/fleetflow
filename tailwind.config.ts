import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // FLEETFLOW design tokens — dark navy / graphite foundation
        ff: {
          bg: '#0b1220',
          surface: '#111a2c',
          border: '#1e293b',
          petrol: '#2563eb',
          cyan: '#22d3ee',
          success: '#34d399',
          warning: '#fbbf24',
          danger: '#f87171'
        }
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(2,6,23,0.5)'
      }
    }
  },
  plugins: []
};

export default config;
