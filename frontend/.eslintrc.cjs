// ESLint baseline for the frontend. Restored in modernization Phase 3 —
// the lint script existed but the config file had been lost, so nothing
// was ever linted. Rules below are calibrated so `npm run lint` passes
// (--max-warnings 0) on the current codebase and can be ratcheted stricter
// over time; rules that would need a codebase-wide cleanup first are noted.
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'coverage', '.eslintrc.cjs', 'vite.config.ts'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // TODO(ratchet): several files export hooks/helpers alongside components;
    // splitting them is Phase 5+ cleanup. rules-of-hooks (error) still applies.
    'react-refresh/only-export-components': 'off',

    // TODO(ratchet): ~40 pre-existing violations. Fixing exhaustive-deps
    // changes runtime behavior (effects re-firing), so each needs individual
    // review — planned alongside the state-layer migration (Phase 5).
    'react-hooks/exhaustive-deps': 'off',

    // Strict typing is a project requirement. This rule sat at 'off' behind a
    // deferred TODO while 326 explicit `any` accumulated across both projects —
    // the tsconfig's `noImplicitAny` never caught them, because an explicit
    // annotation is exactly how you opt out of inference. It is an error now;
    // the `overrides` block at the bottom is the shrinking list of files that
    // still hold the legacy usages.
    '@typescript-eslint/no-explicit-any': 'error',

    // Unused vars are caught by tsc (noUnusedLocals); allow _-prefixed
    // intentional ignores to match existing style.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // Legacy `any`, being burned down cluster by cluster. Entries come off as
      // each file is converted; when this list is empty the block goes with it.
      // The CozyVTT 1.4 merge carries the older MCP and sheet extensions below.
      // Keep these exemptions explicit so new files still fail lint.
      files: [
        'src/components/campaign/CampaignSettingsModal.tsx',
        'src/components/campaign/DiceRoller.test.tsx',
        'src/components/campaign/map/useTokenSocketEvents.ts',
        'src/components/campaign/map/useWallSocketEvents.ts',
        'src/components/character-sheets/CharacterSheetWrapperSave.test.tsx',
        'src/components/character-sheets/call-of-cthulhu-7e/CallOfCthulhu7eCharacterEditor.test.tsx',
        'src/components/character-sheets/call-of-cthulhu-7e/CallOfCthulhu7eCharacterEditor.tsx',
        'src/components/character-sheets/dnd5e/DnD5eCharacterEditor.test.tsx',
        'src/components/character-sheets/dnd5e/DnD5eCharacterEditor.tsx',
        'src/components/character-sheets/dnd5e/DnD5eCharacterSheet.tsx',
        'src/components/character-sheets/dnd5e/DnD5eCharacterView.tsx',
        'src/components/character-sheets/dnd5e/__tests__/DnD5eLiveSync.integration.test.tsx',
        'src/components/character-sheets/dnd5e/dnd5eFormData.ts',
        'src/components/character-sheets/pathfinder2e/Pathfinder2eCharacterEditor.tsx',
        'src/components/character-sheets/types.ts',
        'src/hooks/__tests__/useInitiativeSync.test.tsx',
        'src/hooks/__tests__/useLiveCharacterSync.test.ts',
        'src/hooks/useLiveCharacterSync.ts',
        'src/pages/CharacterEditorPage.test.tsx',
        'src/pages/CharacterEditorPage.tsx',
        'src/services/__tests__/patchCharacterData.test.ts',
        'src/services/__tests__/socket.quiet.test.ts',
        'src/services/__tests__/updateCharacterIfUnchanged.test.ts',
        'src/services/socket.ts',
        'src/test/fakeSocketIo.ts',
        'src/utils/__tests__/character-paths.test.ts',
        'src/utils/__tests__/characterFormStore.test.ts',
        'src/utils/characterFormStore.ts',
        'src/utils/characterMerge.ts',
      ],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
