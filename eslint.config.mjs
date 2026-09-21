import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `.claude/**` is agent scaffolding for building this tool, not tool source:
  // CommonJS hook/statusline helpers the harness loads directly, and excluded
  // from the published snapshot entirely. Linting them as project TypeScript
  // reports 8 no-require-imports errors for code that must use `require`.
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'spike/**', '.claude/**'] },
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
