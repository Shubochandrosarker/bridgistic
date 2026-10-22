/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { DEFAULT: "#0B1B33", 700: "#13294B", 600: "#1D3A66" },
        ivory: "#F7F6F2",
        gold: { DEFAULT: "#C9A227", soft: "#F4E9C8" },
      },
    },
  },
  plugins: [],
};
