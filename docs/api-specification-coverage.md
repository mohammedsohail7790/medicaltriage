# API specification: what it describes and what it does not (NFR-164, NFR-001)

`docs/openapi.json` (served at `/api-docs/openapi.json`, viewer at `/api-docs`) is generated from the routes the application registers, by `pnpm exec tsx scripts/generateOpenApiSpec.ts`. A test fails if the file differs from what the generator produces.

## Coverage

The specification has 235 operations.

| What | Covered |
|---|---|
| Operations that change something (POST, PUT, PATCH): 113 | 78 have a request-body schema taken from the validator the handler runs; the other 35 say they take no body (actions on an item by its identifier) or are a provider callback |
| Request query parameters | Described by schema where the handler validates them (8 operations) |
| Responses | 79 of them have a response schema |
| Error answers | 400, 401, 403 and 429 are described for every operation, with the shared error shapes |

## Where the response schemas come from, and what they are not

Response schemas are **inferred from what the service really answered** (`pnpm observe:responses`, stored in `docs/observed-responses.json`), for every read-only endpoint that has no identifier in its path, signed in as a nurse and as an administrator. They are not written from typed code. Consequences:

- They describe the demonstration build's answers. A field that is empty or absent when there is little data shows as optional, and an array that was empty has no item description.
- Read endpoints that need an identifier, and the answers of operations that change something, are **not described by schema**. They carry only the status codes. That is 156 of the 235 operations.

## Against the replies

The replies to NFR-164 and NFR-001 say the specification has complete request and response schemas for every supported endpoint (and, in NFR-001, 76 paths). It now has 214 paths, every changing operation has its request body described, and response schemas cover 79 operations. **Complete response schemas for every endpoint are not delivered.** Closing that needs the handlers' answers typed (a response schema per route, tested against the route), which is a larger change than this one. Praveen should decide whether the reply is clarified or the work is scheduled.

## Keeping it true

- Handlers that check their own body use the schemas in `src/services/apiContracts.ts`, or carry a `// contract: <Name>` marker over the fields they read. `tests/apiContracts.test.ts` checks that every changing operation has a request schema or says it takes no body, and that the generated file is current.
- After a route changes, run `pnpm observe:responses` and the generator, and commit both files.
