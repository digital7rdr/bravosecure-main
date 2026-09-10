module.exports = {
  presets: ['babel-preset-expo'],
  plugins: [
    [
      'module-resolver',
      {
        root: ['./src'],
        extensions: ['.ios.js', '.android.js', '.js', '.ts', '.tsx', '.json'],
        alias: {
          '@': './src',
          '@screens': './src/screens',
          '@components': './src/components',
          '@navigation': './src/navigation',
          '@services': './src/services',
          '@store': './src/store',
          '@hooks': './src/hooks',
          '@utils': './src/utils',
          '@theme': './src/theme',
          '@appTypes': './src/types',
          '@modules': './src/modules',
          '@bravo/messenger-core': './packages/messenger-core/src',
        },
      },
    ],
  ],
  env: {
    // Why: F-11 — console.log/info/debug survive release bundles and cost
    // JS-thread time (and can leak metadata). error/warn are kept for
    // Crashlytics breadcrumbs and the log-audit surface.
    production: {
      plugins: [['transform-remove-console', {exclude: ['error', 'warn']}]],
    },
  },
};
