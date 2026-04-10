/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#4F46E5',
          50: '#EEF2FF',
          100: '#E0E7FF',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
        },
        surface: {
          DEFAULT: '#F8FAFC',
          card: '#FFFFFF',
          muted: '#F1F5F9',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 24px rgba(15, 23, 42, 0.06)',
        'card-hover': '0 4px 12px rgba(79, 70, 229, 0.08), 0 12px 40px rgba(15, 23, 42, 0.08)',
      },
      maxWidth: {
        content: '72rem',
      },
      keyframes: {
        'bulk-delete-sheen': {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(320%)' },
        },
      },
      animation: {
        'bulk-delete-sheen': 'bulk-delete-sheen 1.15s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
