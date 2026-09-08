// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // src/public/** is plain client-side JS (Lane C's island.js/app.css), not part of the
    // TS project — @typescript-eslint's parserOptions.project would otherwise fail to
    // resolve it.
    ignores: ['dist/**', 'node_modules/**', 'staging/**', 'src/public/**'],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
);
