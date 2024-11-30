module.exports = {
  presets: ['@react-native/babel-preset'],
  overrides: [
    {
      plugins: [['@babel/plugin-proposal-private-methods', {loose: true}]],
    },
  ],
};
