export const members: Record<string, { role: string; tier: string; mark: string; color: string }> = {
  Parser: { role: "Makes sense of words", tier: "luna", mark: "[ ]", color: "#9bcbff" },
  Planner: { role: "Sets the monthly plan", tier: "terra", mark: "▦", color: "#b8a5ff" },
  Pace: { role: "Tracks your daily pace", tier: "terra", mark: "↗", color: "#6de6cf" },
  Anomaly: { role: "Spots unusual spending", tier: "terra", mark: "◇", color: "#ffd08b" },
  Coach: { role: "Turns numbers into advice", tier: "sol", mark: "✦", color: "#f4a8dd" },
  Impact: { role: "Tests before you spend", tier: "terra", mark: "±", color: "#8acbff" },
  Obligations: { role: "Protects the essentials", tier: "terra", mark: "⊞", color: "#c1d98b" },
  "Deal Check": { role: "Checks the real discount", tier: "terra", mark: "%", color: "#ffb4a0" },
  Alternatives: { role: "Finds another way", tier: "terra", mark: "⇄", color: "#a6bbff" },
  Judge: { role: "Makes the final call", tier: "sol", mark: "⊥", color: "#f4d87a" },
};
