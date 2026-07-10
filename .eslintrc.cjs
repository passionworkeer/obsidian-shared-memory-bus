module.exports = {
  env: {
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    'no-console': ['error', { allow: ['error', 'warn'] }],
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '~/.ai-memory/',
    '*.min.js',
    'shared-mcp/node_modules/',
    'ops/node_modules/',
  ],
};
