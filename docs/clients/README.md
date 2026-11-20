# Sample clients

Short, dependency-free examples of calling the API from other stacks. Each one gets a token with the OAuth 2.0 client-credentials grant and then reads the queue.

1. A developer registers on the public developer page and an administrator approves the application; the client id and secret are shown once.
2. `POST /api/v1/oauth/token` with `grant_type=client_credentials`, the client id and the secret returns a bearer token valid for one hour.
3. Send it as `Authorization: Bearer <token>`. A `429` carries `Retry-After`.

| Language | File |
|---|---|
| Java 17+ | `java/AimlTriageClient.java` |
| .NET 8 | `dotnet/AimlTriageClient.cs` |
| curl | below |

```bash
TOKEN=$(curl -s -X POST "$BASE/api/v1/oauth/token" \
  -d grant_type=client_credentials -d client_id="$CLIENT_ID" -d client_secret="$CLIENT_SECRET" | jq -r .access_token)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/queue?limit=5"
```

These examples were written for this repository and compiled by reading, not by running a Java or .NET toolchain here. Run each against your staging service before you rely on it.
