/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'queue-blue': '#2563eb',
        'queue-green': '#10b981',
        'queue-red': '#ef4444',
        'queue-amber': '#f59e0b',
        'queue-gray': '#64748b'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Avenir', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
