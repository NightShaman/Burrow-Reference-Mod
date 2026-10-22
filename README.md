# Burrow Reference Mod

Burrow Reference Mod is the deliberately boring, public reference implementation of Burrow's ordinary third-party mod contract.

It demonstrates a validated manifest, `activate(context)` and cleanup, JSON routes, namespaced settings and encrypted write-only secrets, a grant-required agent tool, Control and Settings UI, an opt-in asynchronous Forge image example, a disabled operator-triggered external agent-turn scaffold, and an actual current-Core integration test. It uses no private Kingdom code, privileged system capabilities, framework, or generated build source.

## Install

The currently published development source is:

```text
https://github.com/NightShaman/Burrow-Reference-Mod.git
```

1. Open **Settings → Mods → Mod sources**.
2. Add the repository URL above.
3. Refresh, install a tagged version, then explicitly enable it.
4. Grant `reference_greet` through ordinary per-agent MCP grants before expecting an agent to call it.

Installation does not grant tools and mod code is not sandboxed. Install only code you trust.

The release workflow publishes UTC calendar-version tags. A GoblinKing-Burrow public-release mirror can be added later through the normal coordinated promotion process; do not assume that mirror exists until it is published.

## Verify

Requires Node.js 22.13 or newer and a sibling `Burrow-Backend` checkout. Override it with `BURROW_CORE_ROOT`.

```sh
npm run build
npm test
npm run test:core
git diff --check
```

The canonical author contract lives in the Burrow documentation under **Develop → Third-party mod contract**.

## Ordinary-mod external agent-turn scaffold

The server also registers a deliberately narrow operator control for `context.agents.turns`. It starts disabled, has no automatic UI action, timer, activation dispatch, agent tool, provider selection, or direct model/provider call.

| Method/path | Request | Result |
| --- | --- | --- |
| `GET /agent-turn/status` | None | Enabled state, bounded agent picker, and retained-request indicator |
| `PUT /agent-turn/configuration` | `{ enabled: boolean }` | Explicit operator enable/disable control |
| `POST /agent-turn` | `{ agentId, sessionId, message, confirmDispatch: true }` | `202` durable acceptance receipt |
| `POST /agent-turn` | `{ confirmDispatch: true }` | Retry an ambiguously failed saved submission with the same key |
| `GET /agent-turn` | None | Later poll of the retained turn ID |

Choose a registered `enabled: true` agent from status. Use an explicit durable session ID representing the external conversation. The example persists one prompt plus a server-generated stable idempotency key before submission, then retains the accepted turn ID and drops its local prompt copy. A `202` response means accepted, not complete: the route never awaits agent/model completion. Poll later. Core runs the ordinary agent turn, scopes keys/turn IDs to this installed mod, and returns only bounded public status/result fields.

If dispatch or receipt persistence fails ambiguously, retry without a new message; the retained key prevents duplicate work. Exact replay returns the same turn. A Core restart can mark queued/running work `interrupted`; replaying the same key still returns that interrupted receipt. A deliberate new attempt needs a new logical request/key. There is no cancellation API. Same-mod ownership is not end-user authorization; a real transport must authenticate and authorize its own sender/chat records and define message-retention policy. This teaching scaffold stores pending prompt text in ordinary settings, not encrypted secrets.

Current-Core tests use its real capability service and external-turn dispatcher with an in-memory receipt store and fake executor. They do not contact a model provider or dispatch paid work.

## Ordinary-mod Forge image example

Configure an available **image** selection in Core’s Forge settings, then open
this mod’s **Control** pane. The pane reports `context.forge.images.status()`
availability without offering provider/model selection. Enter an image prompt
(up to 4,000 characters in this example), check the explicit potential-cost
consent box, and submit. Nothing is generated on activation, page load, refresh,
or agent tool invocation. The greeting tool does not gain image authority.

Creation calls only `context.forge.images.create({ prompt, idempotencyKey })`.
A `202` receipt means **accepted**, not completed. Use **Poll saved image job**
to call `context.forge.jobs.read(jobId)` in a later request. Polling is deliberately
manual: it neither blocks the submitting route nor creates background timers.
Reloading the Control pane or mod host resumes from the saved job ID, not from a
new generation. `queued` and `running` are nonterminal; `succeeded`, `failed`,
and `interrupted` are terminal. Failed reads are not treated as completion.

The example retains just one request in mod-scoped durable settings. It writes a
server-generated idempotency key and pending prompt **before** dispatch, then
writes the job ID and removes the pending prompt after the receipt. If dispatch
or receipt persistence fails ambiguously, **Retry saved submission** resends that
same saved prompt/key, including after host reload. Core namespaces the key by
the trusted installed mod ID and owns paid-dispatch deduplication. Do not replace
an unresolved request with a new key. A new prompt is accepted only after the
retained job reaches a terminal status; it replaces this example’s retained job
ID (not Core’s durable job). Pending prompts are ordinary settings, not secrets;
this demo is not a private prompt vault or a job-history product.

### Mod-owned JSON routes

All responses use `cache-control: no-store`. These routes live under Core’s normal
mod-scoped API namespace and use its trusted request auth, like `/configuration`.
When authentication is enabled, unauthenticated image requests are rejected.
Intentional authentication-disabled installations retain their normal trusted-network
control-plane policy; the checkbox is explicit cost consent, not a new identity
or permission system. No privileged manifest capability is required.

| Method/path | Request | Result |
| --- | --- | --- |
| `GET /images/status` | None | `{ ok, available, reason?, jobId, retryPending }` |
| `POST /images` | `{ prompt, confirmCost: true }` | `202 { ok, job, replayed }` |
| `POST /images` | `{ confirmCost: true }` | Retry unresolved saved submission with the original key |
| `GET /images/job` | None | `{ ok, job }`, or `job: null` before a saved receipt |

Example using the Control host’s scoped `api` helper:

```js
const availability = await api('/images/status');
if (availability.available) {
  // Only after explicit operator authorization of potential cost:
  const receipt = await api('/images', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'A tiny woodland burrow in watercolor', confirmCost: true }),
  });
  // receipt.job.id is already saved by the server. Poll in a later interaction:
  const { job } = await api('/images/job');
}
```

Only the sanitized job returned by Core is forwarded. The UI renders text with
`textContent` and succeeded image artifacts with same-origin authenticated
`/api/forge/jobs/:jobId/artifacts/:artifactId` preview paths. It rejects external,
protocol-relative, data/script, query-string and download URLs. It adds no bearer
tokens, provider credentials, storage references, attachment delivery, cancellation,
downloads, selection controls, or Forge configuration mutation.

The authoritative host contract is the sibling Core checkout’s
[`docs/mod-host-capabilities.md`](../Burrow-Backend/docs/mod-host-capabilities.md).
Tests cover availability, cost/auth/input validation, queued receipts, durable ID
polling after activation/reload, terminal success/failure/interruption, ambiguous
failure retries, concurrency, and safe previews. The integration check uses actual
current-Core discovery, an isolated child host, capability RPC and owner-scoped
projection with an in-memory Forge store. It does **not** call a paid provider or
prove a live PostgreSQL/provider generation. `BURROW_CORE_ROOT` selects that Core
checkout. The manifest/version is unchanged; verification does not publish a release.
