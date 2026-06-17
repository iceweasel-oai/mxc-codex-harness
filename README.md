# MXC Harness

Small Node-based test harness for exercising `@microsoft/mxc-sdk` with smoke-style cases.

This repository is the maintained version of the harness originally published in
[this gist](https://gist.github.com/iceweasel-oai/155c9538d1e19c874eb81441c5742bf0).

The harness is MXC-only. It prints one line per test with a short description and `PASS` or `FAIL`, followed by a summary at the end.

## Layout

- `src/cli.mjs` - runner and report formatting
- `src/cases.mjs` - test case definitions
- `src/mxc-adapter.mjs` - the only file that touches `@microsoft/mxc-sdk`

## Quick start

```powershell
cd windows-sandbox-rs\mxc-harness
pnpm install
node .\src\cli.mjs --dump-sdk
node .\src\cli.mjs --suite all
```

MXC is currently restricted to specific Windows preview builds. If every case
reports a platform or `Experimental_CreateProcessInSandbox` error, the payloads
did not start and negative cases must not be interpreted as successful isolation.

## Suites

- `smoke` - simple file write and deny checks
- `diagnostic` - runtime startup checks for Python and PowerShell
- `network` - coarse network egress checks
- `git` - `.git` protection, including the missing-path case
- `all` - runs every suite

## Results

- [2026-06-17, MXC SDK 0.2.0](docs/results/2026-06-17-mxc-0.2.0.md)
- [2026-06-17, MXC SDK 0.7.0](docs/results/2026-06-17-mxc-0.7.0.md)

## Important note about the SDK adapter

This repo cannot currently verify the exact runtime API exposed by `@microsoft/mxc-sdk`, so the harness keeps that dependency isolated in `src/mxc-adapter.mjs`.

The adapter does three useful things already:

1. It probes the installed package and prints export names with `--dump-sdk`.
2. It tries a few obvious function names automatically.
3. It normalizes a few common result shapes into `{ exitCode, stdout, stderr }`.

If the first real run fails with an adapter error, update only `src/mxc-adapter.mjs`.

## CLI

```powershell
node .\src\cli.mjs --suite smoke
node .\src\cli.mjs --suite network --keep-temp
node .\src\cli.mjs --suite git --root C:\Temp\mxc-harness
node .\src\cli.mjs --dump-sdk
node .\src\cli.mjs --list
```

## Environment variables

- `MXC_SDK_CALL`
  Optional exported function name to try first, for example `run`, `execute`, or `runSandboxCommand`.
- `MXC_ADAPTER_MODULE`
  Optional path to a custom adapter module that exports `runMxcCommand(spec)` and optionally `dumpSdkSurface()`.
- `MXC_PYTHON`
  Python executable to use for Python cases. Defaults to `python`.

## What the harness passes to the adapter

Each test case becomes a normalized spec like this:

```js
{
  command: ["cmd", "/c", "echo ok > ws_ok.txt"],
  cwd: "C:\\path\\to\\workspace",
  env: {},
  writableRoots: ["C:\\path\\to\\workspace"],
  readOnlyPaths: ["C:\\path\\to\\workspace\\.git"],
  networkAccess: "disabled",
  timeoutMs: 15000
}
```

If the MXC SDK uses different option names, translate them in the adapter.
