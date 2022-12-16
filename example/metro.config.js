/**
 * Metro configuration for React Native
 * https://github.com/facebook/react-native
 *
 * @format
 */
const path = require("path");

module.exports = {
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  watchFolders: [
    path.resolve(__dirname),
    path.resolve(__dirname, "../dist"), // Need this to find parent module
  ],
  resolver: {
    extraNodeModules: {
      // Need to also custom-resolve this in order to find parent module
      "react-native-draglist": path.resolve(__dirname, '../dist'),
      // Would love to know how to not have to do this, and yet have the parent
      // module be included via "file:.."
      "react": path.resolve(__dirname, 'node_modules/react'),
      "react-native": path.resolve(__dirname, 'node_modules/react-native'),
    }
  }
};
