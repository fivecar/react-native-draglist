module.exports = {
  preset: "react-native",
  testMatch: ["<rootDir>/src/**/__tests__/**/*.test.@(ts|tsx|js)"],
  // We scope the babel preset here rather than a root babel.config.js so it
  // can't interfere with microbundle's build pipeline.
  transform: {
    "^.+\\.(js|jsx|ts|tsx)$": [
      "babel-jest",
      { presets: ["module:@react-native/babel-preset"] },
    ],
  },
};
