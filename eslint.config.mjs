import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import vitest from '@vitest/eslint-plugin'

/**
 * Static analysis.
 *
 * The rules that earn their place here are the ones a type checker cannot express:
 * a floating promise, an `any` slipping across a boundary, a React hook with a
 * stale dependency. Style is left to Prettier — a linter arguing about formatting
 * trains people to ignore it.
 *
 * Type-aware rules are on, which is slower but the only way to catch an unhandled
 * promise or an unsafe assignment at all.
 */
export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'coverage/**', 'reports/**', 'node_modules/**', '.stryker-tmp/**'] },

  js.configs.recommended,

  {
    /**
     * Scoped to the two TypeScript programs, presets included.
     *
     * The type-aware presets need a program to consult. Spreading them at the top
     * level applied them to the standalone `.mjs` scripts too, where they crash for
     * want of type information — so the `extends` lives inside this block rather
     * than outside it.
     */
    /*
      `.tsx` under `tests` as well, and the omission was worse than it looks.

      `eslint .` skips a file no configuration matches — silently — so every component test was unlinted while
      `--max-warnings 0` passed. No type-aware rules, no `react-hooks` rules, and no `vitest/no-focused-tests`:
      a stray `.only` would have disabled the rest of its file with the gate still green.
    */
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', '*.config.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // --- correctness the compiler cannot see ---------------------------------
      // A dropped promise in the main process means a silent failure in a browser
      // the user is still typing into.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // --- the typed boundary (spec 6) ----------------------------------------
      // Any of these appearing is the drift the specification warns about, arriving
      // through the back door.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      // `as` hides exactly the mismatch the boundary types exist to catch.
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' }
      ],
      /**
       * `noUncheckedIndexedAccess` is on, so every indexed read is
       * `T | undefined`. That makes a `!` here mean something specific: an index
       * whose validity was just established a line or two above — after a length
       * check, or on a regex group the pattern guarantees. Flagging those would
       * push the code towards guards that add noise without adding safety, so the
       * rule is off and the compiler's stricter setting does the real work.
       */
      '@typescript-eslint/no-non-null-assertion': 'off',
      /**
       * `void` in a union is exactly how the bridge distinguishes channels that
       * take no payload: `InvokeRequest<C> extends void | undefined ? [] : [p]`
       * makes a missing argument a compile error for the rest. There is no other
       * way to express it.
       */
      '@typescript-eslint/no-invalid-void-type': 'off',

      // --- clarity -------------------------------------------------------------
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true }
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',

      // --- stylistic rules turned off deliberately -----------------------------
      // The stylistic preset brings opinions that fight this codebase without
      // catching anything. Each is named rather than dropped wholesale, so the
      // decision stays reviewable.
      //
      // `Array<T>` reads better for the nullable and union element types this code
      // uses a lot (`Array<Rect | null>`).
      '@typescript-eslint/array-type': 'off',
      // `on('resize', () => this.relayout())` is clearer than adding braces to
      // discard a void return.
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Dotted setting keys and `process.env` are index signatures; brackets are
      // the honest form.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // Ids and counts are interpolated into log lines and generated names.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowNever: false }
      ],
      // Options objects are passed as `{ getSettings }` collections of plain
      // functions that never touch `this`; the rule cannot see that.
      '@typescript-eslint/unbound-method': 'off',
      // A deliberately empty callback — a no-op unsubscribe, an ignored rejection —
      // is a decision, and each one carries a comment explaining it.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }]
    }
  },

  // --- renderer -------------------------------------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A stale dependency array is the most common source of a UI that shows
      // yesterday's state, which in a browser chrome looks like a core bug.
      'react-hooks/exhaustive-deps': 'warn'
    }
  },

  // --- preload --------------------------------------------------------------
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      // A sandboxed preload cannot require arbitrary modules; catching this here is
      // cheaper than catching it at runtime in a shipped build.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'a sandboxed preload cannot require Node built-ins' },
            { group: ['@main/*'], message: 'the preload must not reach into the main process' }
          ]
        }
      ]
    }
  },

  // --- shared ---------------------------------------------------------------
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      // `shared` is imported by renderers, which have neither Electron nor Node.
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'shared code must stay platform-free' }],
          patterns: [
            { group: ['node:*'], message: 'shared code must stay platform-free' },
            { group: ['@main/*'], message: 'shared code must not depend on the core' }
          ]
        }
      ]
    }
  },

  /**
   * Tests.
   *
   * The strict type-checked preset is written for application code, and tests
   * legitimately do things application code should not: reach into private shapes,
   * assert on deliberately wrong values, and pass a message as a second argument to
   * `expect`. The rules relaxed below are relaxed for that reason and no other —
   * everything that catches a *test* being wrong stays on.
   */
  {
    files: ['tests/**/*.{ts,tsx}'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,

      // A test with no assertion is worse than no test, and a focused test that
      // reaches CI silently disables the rest of the file.
      'vitest/expect-expect': 'error',
      'vitest/no-focused-tests': 'error',
      'vitest/no-identical-title': 'error',
      'vitest/no-disabled-tests': 'warn',
      // Vitest supports `expect(value, 'why this matters')`, which is how these
      // tests say what a failure means. The rule defaults to Jest's single-argument
      // form.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
      // An expectation inside a catch block is exactly how "this must throw the
      // right error" is written.
      'vitest/no-conditional-expect': 'off',

      // Settings keys are dotted strings, so bracket access is the correct form.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // Test names and messages interpolate counts and indices.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Fixtures are known-shaped; a non-null assertion is clearer than a guard.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // A deliberately malformed fixture has to be constructed somehow.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // `() => {}` as a callback that must exist but do nothing.
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': 'off'
    }
  },

  /**
   * Gherkin step definitions.
   *
   * quickpickle hands each step an untyped `state`, so the world accessors in
   * `world.ts` are the one place that narrows it. Requiring the surrounding code to
   * pretend otherwise would add noise without adding safety.
   */
  {
    files: ['tests/features/steps/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // A step may be declared async for symmetry with its siblings even when this
      // particular one has nothing to await.
      '@typescript-eslint/require-await': 'off',
      // A Then step *is* the assertion. quickpickle wraps each scenario in a test,
      // so the expectation is inside one — the rule just cannot see through the
      // wrapper.
      'vitest/no-standalone-expect': 'off',
      'vitest/expect-expect': 'off'
    }
  },

  /**
   * Renderer state that arrives over IPC.
   *
   * The contract types say a payload is complete, and the main process validates
   * that it is — but the value still crossed a process boundary, and a `??` guard
   * against a field the other side failed to send is a deliberate belt alongside
   * the braces, not a redundant check the types can see through.
   */
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off'
    }
  },

  // The ESLint config itself is plain ESM, outside both programs.
  {
    files: ['eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked
  },

  /**
   * Standalone Node scripts.
   *
   * Plain ESM run directly by Node, outside both TypeScript programs, so the
   * type-aware rules do not apply and the runtime globals have to be declared.
   */
  {
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        require: 'readonly'
      }
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off'
    }
  }
)
