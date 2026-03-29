// @ts-check
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const prettier = require('eslint-config-prettier');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        require:       'readonly',
        process:       'readonly',
        console:       'readonly',
        module:        'readonly',
        __dirname:     'readonly',
        __filename:    'readonly',
        setTimeout:    'readonly',
        setInterval:   'readonly',
        clearTimeout:  'readonly',
        clearInterval: 'readonly',
        Buffer:        'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettier.rules,
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'tests/', 'prisma/'],
  },
];
