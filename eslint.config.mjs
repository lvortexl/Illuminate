import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'spike/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // `node --test` runs TypeScript in strip-only mode, which REJECTS `enum`
      // and `namespace` outright. This is a hard runtime constraint, not style.
      // Use `const` objects + `as const` unions instead.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'enum is rejected by type-strip mode — use a const object + `as const` union.',
        },
        {
          selector: 'TSModuleDeclaration[kind="namespace"]',
          message: 'namespace is rejected by type-strip mode — use plain module exports.',
        },
      ],
    },
  },
);
