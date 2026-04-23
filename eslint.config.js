// @ts-check
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'tailwind.config.js', 'vite.config.ts', 'postcss.config.js'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow explicit `any` with a warning — existing code uses it in a few places
      '@typescript-eslint/no-explicit-any': 'warn',
      // Unused vars: error except underscore-prefixed names (intentionally unused)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Allow empty catch blocks (common for "silent ignore" pattern)
      '@typescript-eslint/no-empty-object-type': 'warn',
    },
  },
);
