# KAP-00: Project scaffold and tooling

**Status:** Done

## Goal
A runnable, testable empty service, so every later ticket starts from a green baseline.

## Scope
- `git init`, `.gitignore` (node_modules, dist, `*.db`).
- Node 22 LTS, TypeScript (strict), Fastify, zod, better-sqlite3, Vitest.
- `src/` layout: `domain/`, `application/`, `infrastructure/`, `http/`, plus `app.ts` (builds the Fastify app with injected dependencies) and `server.ts` (entry point).
- npm scripts: `build`, `start`, `dev`, `test`, `typecheck`.
- README skeleton with the agreed sections, and these tickets.

## Tests first
- `GET /health` returns `200 { status: "ok" }` (via `app.inject`, no real port).

## Acceptance criteria
- `npm install && npm test` passes on a clean checkout.
- `npm start` serves `/health`.

## Decisions to record
- Why Fastify (built-in schema/inject testing, light), better-sqlite3 (synchronous transactions make atomic "dedupe + state change" simple), Vitest (fast, native TS).
