/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#0B1F3A", 900: "#07152A", 800: "#0B1F3A", 700: "#132C4F", 600: "#1C3A64", 500: "#2A4D7E" },
        gold: { DEFAULT: "#C6A15B", soft: "#E3CFA4" },
        ivory: { DEFAULT: "#F4F1EA", 200: "#E9E4D8" },
        teal: { DEFAULT: "#1F8A70", soft: "#CDE9E1" },
      },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
};
