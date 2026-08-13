module.exports = {
  preset: 'react-native',
  // The react-native preset's default transformIgnorePatterns assumes a flat
  // node_modules layout. This repo is installed with pnpm, which nests packages
  // under node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/... and also encodes
  // scoped packages with a '+' separator (e.g. @react-native+js-polyfills). The
  // pattern below keeps the preset's allow-list (react-native, @react-native,
  // @react-native-community) but also matches the pnpm layout, so RN's own ESM
  // jest setup files get transformed. It remains compatible with a flat npm
  // node_modules because the (.pnpm/)? prefix and the extra boundary chars are
  // all optional alternatives.
  transformIgnorePatterns: [
    'node_modules/(?!((.pnpm/)?(jest-)?react-native|(.pnpm/)?@react-native(-community)?)(@|/|\\+))',
  ],
};
