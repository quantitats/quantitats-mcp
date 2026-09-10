# orchestrator-mcp

An MCP server over the published trading API. Every `/v1` endpoint an API key
can reach is a tool; the credentials come from the environment and never from a
command line.

It is a client and nothing more. It holds no state, caches nothing, and adds no
endpoint of its own — what a model can do through it is exactly what the key it
was given can do, which is the property that makes it safe to hand to one.

## What it exposes

26 tools, generated from [`src/catalogue.ts`](src/catalogue.ts), which is the
whole surface:

| Area | Tools | Scope |
| --- | --- | --- |
| Bots | `list_bots`, `create_bot`, `stop_bot`, `get_bot_config`, `update_bot_config`, `list_bot_orders`, `get_bot_analytics` | `bots:read` / `bots:write` |
| Market data | `list_instruments`, `get_ticker` | `market:read` |
| Trading | `list_venues`, `list_open_orders`, `list_orders`, `list_venue_open_orders`, `place_order`, `cancel_order`, `cancel_orders` | `trade:read` / `trade:write` |
| Scripts | `list_scripts`, `get_script`, `get_script_config`, `create_script`, `update_script`, `delete_script` | `scripts:read` / `scripts:write` |
| Portfolio | `list_balances`, `get_venue_balances`, `list_positions` | `portfolio:read` |
| Streams | `list_streams` | any valid key |

A scope is not implied by another: a key that lists and starts bots needs both
`bots:read` and `bots:write`.

### What it deliberately does not expose

Stored venue keys, API keys themselves, plan and billing, and administration. No
scope grants those and there is no tool for them, so this is not a gap to fill
later. A key can *use* stored venue keys to trade and can never read, add,
replace or delete one — which is what keeps a leaked key from re-pointing the
account at somebody else's venue account.

Live streams are discovery only. A stream is a long-lived connection and cannot
be read through a request-and-response tool call, so `list_streams` says what
exists and the list tools answer the same questions.

## Configuration

Every setting is an environment variable; see [`.env.example`](.env.example).
The four that matter:

```
ORCHESTRATOR_API_URL=https://api.example.com
ORCHESTRATOR_API_KEY_ID=ak_...
ORCHESTRATOR_API_PRIVATE_KEY_FILE=/run/secrets/api-key.pem   # Ed25519, or:
ORCHESTRATOR_API_SECRET_FILE=/run/secrets/api-secret         # HMAC-SHA256
```

Credentials are read from the environment, or better from a file the environment
points at, and never from argv — an argv is readable by every process on the
machine and lands in shell history, while an MCP client launches this process
with an env block of its own.

The algorithm is inferred from whichever key material is present, and
`ORCHESTRATOR_API_ALG` settles it only when both are.

Two optional narrowings, both off by default:

- `ORCHESTRATOR_MCP_READ_ONLY=true` hides every tool that changes anything.
- `ORCHESTRATOR_MCP_SCOPES=bots:read,trade:read` advertises only the tools those
  scopes reach. A key's scopes cannot be read back from any endpoint, so this is
  stated rather than fetched; leaving it unset advertises everything and lets the
  server refuse.

Neither is a security boundary — the key's own scopes are. They stop a model
spending a call to learn what the manifest could have told it.

## Running it

```bash
npm install
npm run check      # typecheck, tests, build
npm run build      # dist/server.mjs, one bundled file with a shebang
```

Then point an MCP client at the built file:

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/path/to/mcp/dist/server.mjs"],
      "env": {
        "ORCHESTRATOR_API_URL": "https://api.example.com",
        "ORCHESTRATOR_API_KEY_ID": "ak_...",
        "ORCHESTRATOR_API_SECRET_FILE": "/run/secrets/api-secret"
      }
    }
  }
}
```

A configuration problem is reported on stderr and exits 2, naming the variable
to set. stdout carries JSON-RPC and nothing else.

## How a request is signed

The scheme is the API's, restated in [`src/signing.ts`](src/signing.ts). A
signature is taken over six lines joined with `\n`, no trailing newline:

```
<METHOD, uppercased>
<URL path, exactly as dialled>
<raw query string, exactly as sent, "" when there is none>
<X-Timestamp>
<X-Nonce>
<lowercase hex SHA-256 of the raw body>
```

and travels as `X-Signature`, base64, alongside `X-Key-Id`, `X-Timestamp` and
`X-Nonce`. Nothing is normalised beyond uppercasing the method: the query is not
sorted, the path is not re-escaped, and the bytes that are hashed are the bytes
that are sent. Re-serialising a body between signing it and sending it is the
classic way to break a signature, and this client does not.

Two things are worth knowing if you are debugging a refusal:

- The path signed is the **public** one. `/v1/bots` is what you dial and what you
  sign; there is no prefix to add or strip.
- For an HMAC key the signing key is the **decoded** secret, not the base64 text
  you were shown. This client decodes it for you, and refuses text that is not
  base64 rather than signing with whatever could be salvaged from it.

## Tests

```bash
npm test
```

89 tests, all hermetic — nothing reaches the network or a real deployment.

The two that carry the most weight:

- **`test/signing.test.ts`** pins the worked example the API publishes: the body
  hash, the canonical string's exact bytes and length, its SHA-256, and the two
  signatures. The Ed25519 case *verifies* the published signature under the
  published public key, since only the public half was ever published — which
  pins the same thing, because a signature verifies only over the exact string it
  was made from. If one of these fails, this client and the server disagree about
  what a request means.
- **`test/fake-api.ts`** is not a stub. It rebuilds the canonical string from the
  request as it arrived and refuses a signature that does not verify over it,
  exactly as the API does, and it drops `Authorization` the way the published
  listener does. `test/client.test.ts` and `test/server.test.ts` run the whole
  path against it — a real MCP client, this server, a real signature, a real
  verification.

`test/catalogue.test.ts` holds the other line: the method, path and scope of
every tool, copied from the published endpoint reference rather than derived
from the catalogue, so a guard that moves in the API shows up here as a failure
rather than as a 403 someone hits later.

`test/naming.test.ts` checks the tool manifest the server actually serves —
every title, description and argument description, plus the instructions a
client reads before its first call — against the denylist, since a manifest is
squarely something a user observes.

## Layout

```
src/signing.ts     the six-line canonical string and the two primitives
src/config.ts      the environment, validated, with the fix in every message
src/catalogue.ts   every endpoint: method, path, scope, argument schema
src/client.ts      arguments -> signed request -> answer or a readable failure
src/server.ts      one MCP tool per catalogue entry
src/main.ts        stdio transport; stderr for humans, stdout for JSON-RPC
```

Adding an endpoint means adding one entry to `src/catalogue.ts` and its row to
the table in `test/catalogue.test.ts`. There is no second place.
