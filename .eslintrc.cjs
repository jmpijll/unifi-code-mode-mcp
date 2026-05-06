/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
    'plugin:@typescript-eslint/strict-type-checked',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/consistent-type-imports': 'warn',
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: { arguments: false } },
    ],
    'no-console': ['warn', { allow: ['error', 'warn'] }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.js'],
};
