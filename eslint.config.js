import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/dist-types/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly', fetch: 'readonly', Notification: 'readonly', RequestInit: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-undef': 'off',
    },
  },
  {
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { self: 'readonly', URL: 'readonly' } },
  },
);
