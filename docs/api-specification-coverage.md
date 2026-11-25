# API specification: what it describes and what it does not (NFR-164, NFR-001)

`docs/openapi.json` (served at `/api-docs/openapi.json`, viewer at `/api-docs`) is generated from the routes the application registers, by `pnpm exec tsx scripts/generateOpenApiSpec.ts`. A test fails if the file differs from what the generator produces.

## Coverage

The specification has 235 operations.

| What | Covered |
|---|---|
| Operations that change something (POST, PUT, PATCH): 113 | 78 have a request-body schema taken from the validator the handler runs; the other 35 say they take no body (actions on an item by its identifier) or are a provider callback |
| Request query parameters | Described by schema where the handler validates them (8 operations) |
| Responses | 180 of them have a response schema |
| Error answers | 400, 401, 403 and 429 are described for every operation, with the shared error shapes |

## Where the response schemas come from, and what they are not

Response schemas are **inferred from what the service really answered**, not written from typed code. Two sources feed `docs/observed-responses.json`:

1. `pnpm observe:responses` signs in as a nurse and as an administrator and calls every read-only endpoint that has no identifier in its path.
2. A full test run with `RECORD_RESPONSES_FILE=<file>` set records the shape of every JSON answer a route gives (`src/middleware/responseRecorder.ts`, never active in production); `scripts/mergeObservedResponses.ts <file>` folds it in. The tests call most routes with valid input, which is why changing operations and read endpoints with identifiers are covered too.

Consequences:

- They describe what the demonstration build and the tests produced. A field that is absent in some answers shows as optional, an array that was always empty has no item description, and a field that held different types shows as "varies".
- Each schema is filed under the status code actually seen (200, 201 and so on).
- **55 operations are not described by schema.** They are routes the tests never reach with a successful JSON answer: file downloads (the referral PDF), redirects (single sign-on, application launch), empty answers, and routes that need an integration or provider that is not configured in the test environment (for example parts of webhook and job administration, MFA enrolment, the messaging provider callback). They carry only the status codes.

## Against the replies

The replies to NFR-164 and NFR-001 say the specification has complete request and response schemas for every supported endpoint (and, in NFR-001, 76 paths). It now has 214 paths, every changing operation has its request body described, and response schemas cover 180 of 235 operations, inferred from observed answers. **Complete response schemas for every endpoint are not delivered**, and the schemas that exist are inferred, not typed. Closing the rest needs those routes exercised (some need an integration configured) or the handlers' answers typed. Praveen should decide whether the reply is clarified or the work is scheduled.

## Keeping it true

- Handlers that check their own body use the schemas in `src/services/apiContracts.ts`, or carry a `// contract: <Name>` marker over the fields they read. `tests/apiContracts.test.ts` checks that every changing operation has a request schema or says it takes no body, and that the generated file is current.
- After a route changes, run `pnpm observe:responses`, record a test run as above, merge, run the generator, and commit the files.
