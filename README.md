# quantitats-mcp

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

Arguments use the API's own vocabulary, not a friendlier one, because the API is
strict where it matters: an order's side is `BUY` or `SELL`, a status filter is
one of the upper-case statuses, and an order type is one of the seven the API
places (`MARKET`, `LIMIT`, `LIMIT_MAKER`, `STOP_LOSS`, `STOP_LOSS_LIMIT`,
`TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`). A bot's name is trimmed and lower-cased
before it goes into a path, as the API stores it — a stop addressed to `Alpha`
would otherwise answer 204 and stop nothing. `list_open_orders` takes no
filters, because its route reads none; `list_orders` is the one that filters.

## Rate limits

The edge meters the published API per key, in six buckets, and the figures differ
by three orders of magnitude. Every tool states its own in its description, so a
model reads the budget before it plans rather than discovering it by being
refused.

| Bucket | Allowance | Tools |
| --- | --- | --- |
| `trade-write` | 932 / minute | `place_order`, `cancel_order`, `cancel_orders` |
| `default` | 600 / minute | the bot, script and order **reads** |
| `venue-private` | 60 / minute | `list_balances`, `get_venue_balances`, `list_positions`, `list_venue_open_orders` |
| `control-plane` | 30 / minute | `create_bot`, `stop_bot`, `update_bot_config`, `create_script`, `update_script`, `delete_script` |
| `venue-public` | 60 / **hour** | `list_instruments`, `get_ticker` |
| `ws-ticket` | 60 / **hour** | `list_streams` |

Three of those are worth knowing before writing a client:

- **`venue-public` is 60 an hour, not a minute.** Those two endpoints serve a
  cached copy and never reach a venue, so the allowance is the cache's lifetime
  rather than a polling budget. Read an instrument list once and keep it; for
  prices more often, read the venue's own public API, which is free and
  authoritative.
- **`venue-private` spends your allowance twice.** Each call reaches the venue
  with your own key, so it counts there as well as here — and a balances read
  naming no venue is one request here and up to eleven there.
- **`default` and `control-plane` share the `/v1/bots` prefix.** Reading is 600 a
  minute and writing is 30. Which bucket a path falls into is not derivable from
  the path, which is why [`src/catalogue.ts`](src/catalogue.ts) states it per
  endpoint.

Windows are **fixed, not sliding**: a bucket refills at the top of the minute or
the hour, so the whole allowance can be spent at once and then waited out.

The server does three things with this:

1. **Says it up front** — in every tool description, and in the instructions a
   client reads before its first call.
2. **Counts locally** and refuses before dialling, so a model that would have
   blown through a bucket gets a "wait 34s, nothing was spent" it can recover
   from inside the same window. The counter aligns to the same wall-clock
   boundaries the edge uses. It is not a security control and errs towards
   allowing — the edge is the authority.
3. **Reports what is left**, from the edge's own `x-ratelimit-*` headers, but
   only once a tenth of the bucket remains. A note on every call trains a reader
   to skip the line, and then the one that matters is skipped too.

[`src/ratelimits.ts`](src/ratelimits.ts) mirrors the deployed policy, and
[`test/ratelimits.test.ts`](test/ratelimits.test.ts) reads that policy and fails
when a figure moves on one side only.

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
Two are needed — the key id and its key material:

```
QUANTITATS_API_KEY_ID=ak_...
QUANTITATS_API_PRIVATE_KEY_FILE=/run/secrets/api-key.pem   # Ed25519, or:
QUANTITATS_API_SECRET_FILE=/run/secrets/api-secret         # HMAC-SHA256
```

Requests go to `https://api.quantitats.com/v1/*` — `list_bots` dials and signs
`https://api.quantitats.com/v1/bots`. `QUANTITATS_API_URL` overrides the host for
a self-hosted or staging deployment and takes an **origin with no path**: the
`/v1` is on the endpoint, not the base, so one configuration cannot disagree with
the paths the catalogue signs. A base carrying a path is refused at startup,
because a segment that is in the dialled URL but not in the signed string is a
signature that never verifies.

Credentials are read from the environment, or better from a file the environment
points at, and never from argv — an argv is readable by every process on the
machine and lands in shell history, while an MCP client launches this process
with an env block of its own.

The algorithm is inferred from whichever key material is present, and
`QUANTITATS_API_ALG` settles it only when both are.

Two optional narrowings, both off by default:

- `QUANTITATS_MCP_READ_ONLY=true` hides every tool that changes anything.
- `QUANTITATS_MCP_SCOPES=bots:read,trade:read` advertises only the tools those
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
    "quantitats": {
      "command": "node",
      "args": ["/path/to/mcp/dist/server.mjs"],
      "env": {
        "QUANTITATS_API_KEY_ID": "ak_...",
        "QUANTITATS_API_SECRET_FILE": "/run/secrets/api-secret"
      }
    }
  }
}
```

A configuration problem is reported on stderr and exits 2, naming the variable
to set. stdout carries JSON-RPC and nothing else.

### From the image

```bash
docker run -i --rm \
  -e QUANTITATS_API_KEY_ID=ak_... \
  -e QUANTITATS_API_SECRET=... \
  <registry>/<owner>/<repo>/mcp:latest
```

`-i` is not optional: the transport is stdin and stdout, so without a stdin the
process has nothing to read and exits having answered nothing. There is no port
and no healthcheck — this is a tool a client launches, not a service that listens.

## Versioning

One version per build, derived from git ([`scripts/version.mjs`](scripts/version.mjs)),
stamped into the bundle and reported to a client as `serverInfo.version`:

| Built at | Version |
| --- | --- |
| a `v1.2.3` tag on HEAD | `1.2.3` |
| any other commit | `0.1.0-dev.<commits>+<sha>` |
| an uncommitted tree | the above plus `.dirty` |
| no repository (a tarball, or the image build) | `0.1.0+unknown` |

`-dev`, not `+dev`: semver sorts a prerelease *below* the plain version, which is
the direction that makes "is this newer than 0.2.0" answerable.

CI computes the version once and passes it to every architecture as a build
argument, so the image tag and the string a client reads cannot disagree — and it
has to be passed in, because `.dockerignore` excludes `.git` and an image build
cannot see the repository. Container tags replace the semver `+` with `_`, which a
reference may not carry.

Nothing creates a git tag automatically. A release is `git tag v1.2.3 && git push
--tags`; CI that tagged on its own would make the version history a function of
merge order rather than of anybody's decision.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on a Gitea forge,
written in GitHub Actions syntax because Gitea reads `.github/workflows` too.
**Do not add a `.gitea/workflows` directory** — precedence is
first-directory-exists-wins, so it would silently stop everything in here from
running while still looking fine.

- **On a pull request:** typecheck, test, bundle. Nothing is published.
- **On a push to `main`:** the same, then a multi-architecture image tagged
  `latest`, `sha-<sha>` and the dev version.
- **On a `v*` tag:** the same, tagged `1.2.3`, `1.2`, `1` and `latest`.

**No job asks for an architecture-specific runner.** Every `runs-on` is
`ubuntu-latest`, so any runner on the forge can take any job — a label like
`ubuntu-latest-amd64` is a *request*, and with nothing carrying it a job does not
fail, it queues until the whole run times out.

The price is emulation: QEMU is installed and buildx builds every platform in one
invocation, pushing the manifest directly. That is affordable here because
nothing in this image is architecture-specific — the output is JavaScript, so an
emulated build produces the same bytes as a native one and costs only time.

arm64 is still opt-in, via `BUILD_ARM=true` as an environment or repository
variable, because emulating it takes several times what amd64 does and most
pushes do not need it.

Publishing needs `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` secrets; the built-in
job token cannot write to Gitea's registry.

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

- The path signed is the **public** one. `https://api.quantitats.com/v1/bots` is
  the address, `/v1/bots` is the second canonical line, and there is no prefix to
  add or strip. The internal `/api` is never dialled or signed.
- For an HMAC key the signing key is the **decoded** secret, not the base64 text
  you were shown. This client decodes it for you, and refuses text that is not
  base64 rather than signing with whatever could be salvaged from it.

## Tests

```bash
npm test
```

162 tests, all hermetic — nothing reaches the network or a real deployment.

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
rather than as a 403 someone hits later. Its "what the API accepts" block does the
same for the argument schemas — the sides, statuses, order types and loss-limit
shapes the handlers take, and a bot's name as they store it.

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
