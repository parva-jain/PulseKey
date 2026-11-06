// Tokens from the Stitch design system ("Pool — calm editorial").
module.exports = {
  content: [__dirname + "/index.html", __dirname + "/src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["Newsreader", "Georgia", "serif"],
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      colors: {
        paper: { DEFAULT: "#FAF8F4", muted: "#F4F0E8", light: "#FAF8F4", deeper: "#F1ECE2" },
        borderWarm: "#E8E4DC",
        ink: "#1C1B22",
        muted: "#6B6876",
        line: "#E8E4DC",
        indigo: { DEFAULT: "#2E3A6B", hover: "#242F56", light: "#EEF1F8", muted: "#BAC8E2" },
        gold: { DEFAULT: "#C8912E", bg: "#FDF8EC", border: "#F4DEAF", subtle: "#FDF7EB" },
        sage: { DEFAULT: "#4F8A6E", bg: "#EFF6F2", border: "#D0E3D8", subtle: "#EDF5F1" },
        brick: { DEFAULT: "#B4483C", bg: "#FBEFED", border: "#EBC7C1" },
        amber: { DEFAULT: "#B7791F", bg: "#FCF4E6", border: "#EFD6A8", subtle: "#FCF5EA" },
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.02)",
        cardHover: "0 12px 32px -4px rgba(28, 27, 34, 0.08), 0 4px 12px -2px rgba(28, 27, 34, 0.04)",
        phone: "0 24px 60px -12px rgba(28, 27, 34, 0.12), 0 8px 24px -6px rgba(28, 27, 34, 0.06)",
      },
      borderRadius: { 20: "20px" },
    },
  },
};
