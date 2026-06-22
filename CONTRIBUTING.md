# Contributing

Thanks for taking a look. This is a small, focused project — contributions that keep it that way are very welcome.

## Running the tests

The portable suite has zero dependencies (Node's built-in `assert` + bash):

```bash
npm test
```

It runs the pure-function router tests and the two standalone integration tests. Everything should be green on a fresh checkout. CI runs the same command on Node 18 and 20.

> The other `*.test.mjs` / `*.test.ts` files are coupled to the internal agenthub monorepo (they reference `../../../harness`, `packages/core/agenthub`, etc.) and only run there. They ship as reference and are intentionally **not** run by `npm test`.

## What changes are easy to land

- **Routing rules** live as data in [`config/route-rules.json`](./config/route-rules.json), consumed by the pure function in [`scripts/route-review.mjs`](./scripts/route-review.mjs). Change the data, add a case to `scripts/route-review.test.mjs`, keep it green.
- **A new review runner** (Gemini, a local model, your own setup): copy [`examples/codex-runner.sh`](./examples/codex-runner.sh) and swap the engine call. It must honor the runner contract and the pass-evidence rules in [`references/pass-evidence-contract.md`](./references/pass-evidence-contract.md).

## Ground rules

- **Keep the trust loop intact.** A `pass` must carry its evidence fields, and `riskDisposition` is never auto-filled — see the contract above. Don't add a code path that lets an empty pass through.
- **Code owns the thresholds; prose explains the intent.** If you change behavior, update the test, not just the docs.
- **Add a test for behavior changes.** A change without a regression test is hard to accept.

## Reporting issues

Open an issue with a minimal `--input` that reproduces the behavior, the command you ran, and the verdict/exit code you got vs. expected.
