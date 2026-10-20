# Burrow Reference Mod

Burrow Reference Mod is the deliberately boring, public reference implementation of Burrow's ordinary third-party mod contract.

It demonstrates a validated manifest, `activate(context)` and cleanup, JSON routes, namespaced settings and encrypted write-only secrets, a grant-required agent tool, Control and Settings UI, and an actual current-Core integration test. It uses no private Kingdom code, privileged system capabilities, framework, or generated build source.

## Install

1. Open **Settings → Mods → Mod sources**.
2. Add `https://github.com/GoblinKing-Burrow/Burrow-Reference-Mod.git` for public releases, or `https://github.com/NightShaman/Burrow-Reference-Mod.git` for development builds.
3. Refresh, install a tagged version, then explicitly enable it.
4. Grant `reference_greet` through ordinary per-agent MCP grants before expecting an agent to call it.

Installation does not grant tools and mod code is not sandboxed. Install only code you trust.

## Verify

Requires Node.js 22.13 or newer and a sibling `Burrow-Backend` checkout. Override it with `BURROW_CORE_ROOT`.

```sh
npm run build
npm test
```

The canonical author contract lives in the Burrow documentation under **Develop → Third-party mod contract**.
