# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build/Test/Lint Commands
- Build: `npm run build` (or `cd codex-cli && npm run build`)
- Development: `npm run dev` (or `cd codex-cli && npm run dev`)
- Test all: `npm test` (or `cd codex-cli && npm test`)
- Test single: `cd codex-cli && npx vitest run tests/path/to/test.test.ts`
- Lint: `npm run lint` (or `cd codex-cli && npm run lint`)
- Type check: `npm run typecheck` (or `cd codex-cli && npm run typecheck`)
- Format check: `npm run format` (or `cd codex-cli && npm run format`)
- Format fix: `npm run format:fix` (or `cd codex-cli && npm run format:fix`)

## Code Style Guidelines
- **TypeScript**: Strict type checking enabled. Always include explicit return types for exported functions.
- **Imports**: Use consistent type imports. Order imports alphabetically with types grouped separately.
- **Formatting**: 80 character line limit, 2 space indentation, trailing commas, semicolons required.
- **Error Handling**: No silent failures. Use explicit error handling with proper typing.
- **Naming**: Use camelCase for variables/functions, PascalCase for classes/interfaces/types.
- **React**: Follow React hooks rules strictly. Ensure exhaustive dependencies in useEffect.
- **Testing**: Use Vitest with mocks. Each test file should correspond to a source file.
- **No console.log**: Don't use console.log in production code; it's flagged by ESLint.