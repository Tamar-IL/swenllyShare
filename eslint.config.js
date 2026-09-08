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
  // ---------------------------------------------------------------------------------
  // Boundary rules (architecture.md §2: "enforced by review + a lint rule per
  // direction"). Fix pass 4, code review finding 3 — these previously existed only as
  // a claim in the doc; nothing here actually caught a domain->adapter or
  // http->repository import. Each block below is self-contained (its own full
  // `no-restricted-imports` options object) rather than split across multiple
  // same-glob blocks: in flat config, two config objects that both set the same rule
  // for an overlapping file replace each other's options entirely rather than merging,
  // so splitting "forbid pg" and "forbid adapters" into separate blocks that both match
  // src/domain/**, say, would silently drop whichever one loads first.
  {
    // Rule 2: domain services never import an adapter, HTTP code, job-queue code, or
    // `pg` itself directly — only a port interface (injected by container.ts) and, for
    // `pg`'s concrete types, the `Pool`/`PoolClient` aliases re-exported from
    // `src/db/pool.ts` (rule 3 below).
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'Domain services may not import pg directly (architecture.md §2 rule 3) — ' +
                'import the Pool/PoolClient/Queryable types re-exported from src/db/pool.js instead.',
            },
          ],
          patterns: [
            {
              group: ['**/adapters/**'],
              message:
                'Domain services may not import an adapter directly (architecture.md §2 rule 2) — ' +
                'depend on the port interface instead, injected via container.ts.',
            },
            {
              group: ['**/http/**'],
              message: 'Domain services may not import src/http/** (architecture.md §2).',
            },
            {
              group: ['**/jobs/**'],
              message: 'Domain services may not import src/jobs/** (architecture.md §2).',
            },
          ],
        },
      ],
    },
  },
  {
    // Rule 1: HTTP handlers contain no SQL — they parse, authorize, call one domain
    // service (via container.ts), and render. Direct repository or adapter access from
    // a route bypasses the domain layer that owns tenant scoping and business rules.
    files: ['src/http/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'HTTP handlers may not import pg directly (architecture.md §2 rule 3) — ' +
                'call a domain service via container.ts instead.',
            },
          ],
          patterns: [
            {
              group: ['**/db/repositories/**'],
              message:
                'HTTP handlers may not query a repository directly (architecture.md §2 rule 1) — ' +
                'call a domain service via container.ts instead.',
            },
            {
              group: ['**/adapters/**'],
              message:
                'HTTP handlers may not import an adapter directly (architecture.md §2 rule 1) — ' +
                'call a domain service via container.ts instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Rule 3: "only repositories issue SQL" (architecture.md §2 rule 3) also means only
    // the files that make SQL possible — the repositories themselves, the pool/
    // transaction helper, and the standalone migration runner — may import the `pg`
    // driver at all. Everywhere else (jobs/**, adapters/**, container.ts, ports/**,
    // lib/**, top-level server/app/worker files, ...) reaches Postgres only through a
    // repository call or the Pool/PoolClient types db/pool.ts re-exports. domain/** and
    // http/** already carry this same restriction above (each combined with their own
    // extra patterns, per the note at the top of this section), so they're excluded
    // here to avoid two same-rule blocks fighting over the same files.
    files: ['src/**/*.ts'],
    ignores: [
      'src/domain/**',
      'src/http/**',
      'src/db/repositories/**',
      'src/db/pool.ts',
      'src/db/migrate.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pg',
              message:
                'Only src/db/repositories/**, src/db/pool.ts, and src/db/migrate.ts may import ' +
                'pg directly (architecture.md §2 rule 3) — use the Pool/PoolClient/Queryable ' +
                'types re-exported from src/db/pool.js, and reach Postgres through a repository.',
            },
          ],
        },
      ],
    },
  },
);
