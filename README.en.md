# VeriScope Offline Gate Replay · DSH Plugin

[中文](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.md) · **English** · [日本語](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ja.md) · [한국어](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ko.md)

> This page is a translation of the Chinese original. If the two ever disagree, the Chinese original is authoritative.

> **Upgrading to the 0.6.0 local candidate**: existing receipts become REVIEW for current validity; historical PASS/FAIL verdicts are not rewritten. Back up the complete state directory and original archives before upgrading, and use a persistent state directory outside the plugin. Package-local `.local` may be lost on reinstall; exporting a receipt is not a complete backup. Run replay for ReceiptV1 or check for ReceiptV2 to obtain a new receipt.

Check existing scores with a standalone Node threshold gate, or replay VeriScope archives with the original Python Quality Gate. Both return **PASS / FAIL / REVIEW** and verifiable local receipts.

[GitHub](https://github.com/4444wjt/dsh-plugin-veriscope) · [Gitee mirror (manually synchronized)](https://gitee.com/kkbushishou/dsh-plugin-veriscope) · Full VeriScope: [main repo](https://github.com/4444wjt/RAG_Evaluation_Demo) / [mirror](https://gitee.com/kkbushishou/rag-hallucination-evaluator). Issues and PRs go to GitHub.

Python remains the numeric judge for replay; B2 selects the separate `builtin-threshold-v1` or `builtin-threshold-v2` engine by policy. REVIEW never becomes PASS, and a confirmed FAIL is never masked by additional anomalies. PASS only means the archived metrics passed the bound gate; it does not prove any answer is factually correct. The plugin does not re-evaluate, does not modify archives, and performs no publish or Git operations.

---

The legacy VeriScope instructions below apply to replay. B2 input, judgments and receipts follow the separate section above.

Accepts the original VeriScope archives plus B2 GateArchiveV1 and the specified Ragas records layout. Unsupported formats are rejected, not guessed or converted.

## Use existing scores directly: B2 (0.6.0 local candidate)

Already have Ragas scores? Export the score JSON, specify the metrics and thresholds, and let the plugin check the gate and save a receipt. **No VeriScope installation and no new model scoring calls.**

Only Node ≥22.19 is required. Set an explicit, writable, persistent `VERISCOPE_STATE_DIR` before starting the host. There is no settings UI and `.env` is not read. B2 does not use VeriScope/Python paths.

> Use `veriscope_gate_check` for `D:\data\scores.json` with policy `D:\data\policy.json` and format `ragas-records-v1`; explain the verdict.

```powershell
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
node scripts/check.mjs --archive examples/builtin/ragas-records.json --policy examples/builtin/policy.json --format ragas-records-v1 --json
```

- Accepts `GateArchiveV1` or the Ragas `result.to_pandas().to_json(orient="records")` layout, with an explicit `GatePolicyV1` or `GatePolicyV2`; no field or threshold guessing.
- Uses an equally weighted mean of all provided rows. Missing values are neither filled nor skipped. A failing complete mean or a known valid row violating an explicit row threshold yields FAIL; otherwise incomplete evidence yields REVIEW. All required data and constraints must pass for PASS.
- Never renames `faithfulness` to `pos_faithfulness`. A B2 PASS is not the original gate verdict, does not establish factual correctness or score authenticity, and cannot reveal rows removed before export.
- DSH/MCP expose check; the installed CLI is `veriscope-check`. `doctor({engine:"builtin"})` does not probe Python. status/list handle both receipt versions.
- B2 uses ReceiptV2 and text only, without bind/complete. DSH JSON/Markdown export works; B2 share is unsupported. Records are kept indefinitely with no automatic cleanup.

**A passing mean can still reveal a weak row.** Per-metric diagnostics show the worst valid row and count rows outside the mean threshold; diagnostics do not change the verdict. Opt in with `GatePolicyV2` and `row_threshold`, using the metric's existing direction and unit. In the constructed example, a mean of 0.81 includes a 0.41 row: mean-only can PASS, while requiring every row to be ≥0.5 yields FAIL. V2 compares original JSON numeric tokens as exact decimals; V1 floating-point decisions remain unchanged.

See packaged `docs/B2.md`, `schemas/` and `examples/builtin/`. Examples are constructed, not real evaluations. Version 0.6.0 is published to npm. Windows and Ubuntu remote CI, including real replay against the pinned upstream, both passed; Claude complete structured error delivery remains unverified. Historical 0.5.0 evidence remains in `docs/acceptance-b2-v0.5.0.json`.

## Original VeriScope path: quick start

After configuring the environment (next section), type these in DSH:

1. "Use `veriscope_doctor` to check this machine and tell me what needs fixing."
2. "Use VeriScope to check `D:\data\evaluation-result.json` and explain whether it passes and why."
3. "Use `veriscope_gate_list` to list recent gate receipts and their current validity."

Then you can also ask:

> Check whether the last gate result is still valid.

A doctor result of "environment ready" only means the environment is usable; passing the gate requires an actual replay. Whether chat selects the tool automatically depends on the DSH model configuration; name the tool explicitly when needed.

Three small scenarios:

- **Sending to a maintainer**: "Turn this gate failure into a shareable help summary." `format: "share"` writes a local Markdown file — preview it, then share it yourself. It is not a receipt.
- **Archive will not open**: replay reports the line/column or field location when it can be determined; it never edits the file.
- **Passed yesterday, needs review today**: the status check lists confirmed changes to thresholds, versions and input digests; anything unverified is kept explicitly unverified.

To constrain task completion, bind the current check to a task. Only a bound receipt that is currently valid and PASS can register completion.

**Configure the VeriScope and Python paths before use. The plugin makes no new evaluation-model calls.**

## Install and configure

This document covers the **0.6.0 local candidate**, with a DSH plugin and the independent `veriscope-mcp` entry. Check the [npm package page](https://www.npmjs.com/package/dsh-plugin-veriscope) for available releases; MCP setup and pending checks are described below. The verified DSH CLI requires an explicit profile; these examples use the isolated `veriscope-demo` profile:

```powershell
# install
dsh plugin --profile veriscope-demo add dsh-plugin-veriscope
# show the installed version
dsh plugin --profile veriscope-demo list dsh-plugin-veriscope --depth 0
# uninstall
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

For local development or customization, install from a local directory instead:

```powershell
dsh plugin --profile veriscope-demo add 'D:\your-workspace\dsh-plugin-veriscope'
```

Replace the path with the real source location. Do not treat a directory or link install as evidence of a registry install. **A successful install is not a passing gate**: first use of legacy replay requires `VERISCOPE_ROOT`, `VERISCOPE_PYTHON` and a doctor run; B2 only requires the state root. The npm package excludes tests; it includes `docs/B2.md`, schemas and B2 examples, with other documentation in the repository; `npm test` is for source development only, and `node scripts/verify-replay.mjs` only works in the full source repository with its verification material present — neither is an installed capability. See the repository for full documentation.

Historical 0.3.x verification: Windows with DSH NEXT 2.0.18-next and internal DSH / tools / skill **0.2.1-alpha.2**. Node ≥22.19. Other host versions are unverified. Upstream plus Python / pandas compatibility is also required; pinned dependencies are in [upstream notes](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/UPSTREAM.md). The plugin does not bundle the full upstream or any business archive.

The DSH entry requires `@deepseek-ai/dsh-tools` version `0.2.1-alpha.2`, checks the version before loading SDK code, and then checks `defineTool`. Missing, incompatible and unloadable SDKs report `SDK_MISSING`, `SDK_INCOMPATIBLE` and `SDK_LOAD_FAILED`. It never installs or switches SDK versions automatically; these checks do not replace host acceptance. MCP does not load the DSH SDK.

### Configuration

**There is no settings UI, and `.env` is not read automatically.** Paths come only from the host process environment; the cordis patch accepts only `completionMode`. The host's own environment-loading policy is up to the host.

| Setting | Entry point | Default and requirements |
|---|---|---|
| `veriscopeRoot` | `VERISCOPE_ROOT` | Windows default: `D:\RAG_Evaluation_Demo`; required explicitly on POSIX |
| `pythonPath` | `VERISCOPE_PYTHON` | Probes `.venv` / `venv`: `Scripts/python.exe` on Windows, `bin/python` on POSIX; never falls back to PATH |
| state root | `VERISCOPE_STATE_DIR` | Legacy DSH replay defaults to `<plugin dir>/.local`; B2 and all MCP tools require an explicit persistent directory |
| reminder mode | cordis patch `completionMode` | `off`; only `off` or `remind`; anything else is an error |

Explicit values for all three environment variables must be non-empty absolute paths; invalid values never fall back silently. Set them **in the same terminal that starts DSH**, then start or fully restart the host. The last line below is an alternative to the npm install above, for installation from GitHub; skip it if the plugin is already installed:

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
dsh plugin --profile veriscope-demo add github:4444wjt/dsh-plugin-veriscope
```

Prepare a dedicated profile and the matching host CLI first; the install command does not create a full host configuration. The plugin bundle inserts a default entry; override it by existing `id` in `<DSH_HOME>/profiles/<name>/cordis.patch.yml` rather than inserting again:

```yaml
- id: dsh-plugin-veriscope
  config:
    completionMode: "remind"
```

`off` disables turn-stop reminders; all tools remain available. `remind` only reminds about unfinished bound tasks and does not promise a global block on ordinary chat. Paths cannot be written into this config.

## Cross-host MCP

MCP still exposes five tools; V2 policies use the existing check/status/list tools. Historical 0.5.0 host evidence and pending items remain in `docs/acceptance-b2-v0.5.0.json` and do not verify this candidate. The following paragraph is historical 0.4.0 evidence.

For 0.4.0, actual tool calls were verified in isolated Claude Code and Codex host control runtimes without model conversations. Real replay passed on Windows and Ubuntu. Claude returns tool errors as text through its control API; complete structured error delivery remains unverified. Start source `mcp.js` with an absolute Node path; see [MCP setup](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/MCP.md) for configuration and isolated examples. It does not load the DSH SDK. The first MCP adapter exposes only `veriscope_doctor`, `veriscope_gate_replay`, `veriscope_gate_status`, and `veriscope_gate_list`, with no native result card. batch/export and bind/complete remain DSH-only. Session bindings are not ported; MCP reports have `execution.session_id: null`.

All five current MCP tools require an explicit, valid `VERISCOPE_STATE_DIR`; a missing value returns REVIEW without falling back to the package directory. doctor writes and removes a temporary probe; replay writes reports and receipts. Neither is read-only; the added check also writes records. status/list are read-only. A business FAIL is not a tool execution error. Host tool calls, real Linux replay, and version checks are recorded separately in [acceptance evidence](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/acceptance-mcp-v0.4.0.json); registration or a custom client passing does not establish host acceptance.

## The nine tools

| Tool | Purpose |
|---|---|
| `veriscope_gate_check({archive_path, policy_path, format?})` | Node-only threshold gate on existing row scores; produces ReceiptV2 without Python |
| `veriscope_doctor({engine?})` | Checks the legacy replay environment by default; `engine:"builtin"` checks only Node and the explicit state root, with fix suggestions |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | Actually runs the gate on an existing archive, saves an independent record, and produces ReceiptV1 when eligible |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | Read-only check of receipt validity; no replay, no scoring, no new receipt |
| `veriscope_gate_list({limit?})` | Lists the 50 most recent by default (1–200 allowed); reuses status per item and lists damaged records separately |
| `veriscope_gate_batch({paths?, dir?, baseline?, faith?, ctx?})` | Path array or directory, not both; sequential replay, up to 200, cancellable, one record per item |
| `veriscope_gate_export({run_id?, run_ids?, format})` | Exports 1–50 records under the state root's `exports/`; `share` is a whitelisted help summary, `md` a full report, `json` the original receipt; never overwrites |
| `veriscope_gate_bind({task_id, run_id, faith?, ctx?, baseline_run_id?})` | Binds a managed task to the current receipt inside the host-provided session |
| `veriscope_gate_complete({task_id, run_id})` | Re-verifies the session binding and registers completion only under a currently valid PASS |

### Parameters and rules

- Legacy replay thresholds default to 0.8, must be finite values in 0–1, and are never automatically lowered to obtain PASS.
- Archive-relative paths resolve against `VERISCOPE_ROOT`.
- For `baseline_run_id`, omission keeps the original baseline, `null` requires no baseline, and a UUID references a valid receipt in the current state root.
- `task_id` is 1–80 characters of letters, digits, underscore, dot or hyphen; the session identity cannot be forged through tool parameters. Bindings live in memory only, must be re-bound after restart, and completion records on disk do not restore authorization.

Use status to "check validity" and replay to "run the gate again". ReceiptV1 requires an actual replay; ReceiptV2 requires an actual B2 check. When input, baseline, policy, upstream, plugin or environment change, the old receipt moves to needs-review while historical failures are preserved. See [receipt protocol](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RECEIPTS.md).

Version 0.4.0 accepts either the original audited contract or the LF contract audited from public commit `1b89bcabb83e1b123039799516596fdcfd393d42`. An entire contract must match original bytes: no per-file mixing or runtime normalization. Receipt hashes now cover the MCP entry, shared catalog, and contract selector. Upgrades make old receipts currently REVIEW while preserving their historical records.

### Example inputs and outputs

```text
veriscope_doctor({})
-> {status:"READY", ready:true, summary:"环境就绪", items:[…]}
veriscope_gate_list({limit:10})
-> {items:[{run_id:…, historical_verdict:"PASS", current_verdict:"REVIEW", …}], damaged:[…]}
veriscope_gate_batch({paths:["a.json","b.json","broken.json"]})
-> {status:"FAIL", counts:{pass:1, fail:1, review:0, error:1}, …}
veriscope_gate_export({run_id:"actual run UUID", format:"md"})
-> {exported:true, path:"<state root>/exports/<unique name>.md", …}
veriscope_gate_export({run_id:"actual run UUID", format:"share"})
-> {exported:true, share_summary:{schema_version:"GateShareSummaryV1", is_receipt:false, …}, …}
```

These are field examples, not measured business results. A batch **aggregates to FAIL if any item fails**; with no FAIL but with needs-review, errors, cancellations or unprocessed items it is REVIEW. Directories are read non-recursively for JSON files they contain. Errors never mask a confirmed failure, and a failure never stops the next replay.

### Listing, batch and export

Listing scans at most 10,000 directory entries and reports needs-review explicitly when exceeded; receipts outside the `limit` range are not re-verified against the current environment. When a damaged receipt's timestamp cannot be read reliably, sorting uses the directory modification time and says so. A single-record JSON export is byte-identical to the original receipt; multiple records become an array of untouched receipt objects. A historical PASS inside JSON does not mean it is currently valid — current state is in the returned `current` field. Markdown lists both historical and current state, archived metrics, thresholds, evidence count and limitations. The doctor only creates and removes its own temporary probe files; it changes no configuration and installs no dependencies.

`share` additionally writes Markdown containing only fixed states, known reasons, bounded metrics and thresholds, counts and strict version numbers. It omits paths, original text, logs, model labels, times, hashes and unknown fields, and replaces run IDs with aliases such as "record 1". Share **the file body or `share_summary`** — the whole tool return still contains a local file location. Numbers and versions may also be sensitive; preview first. The summary cannot be used for status, bind or complete, does not prove factual correctness, and does not guarantee that every secret is detected.

### Diagnostics and change notes

When JSON is rejected, `execution.errors[].diagnostic` gives a confirmable detection point: line and column start at 1 and count decoded UTF-16 units, with CRLF treated as one newline. The restricted field path is `null` when it cannot be determined safely, and original text is never echoed. The position is not necessarily the only place that changed; nothing is auto-fixed or retried.

status `changes` explains only the fixed binding fields between the original receipt and the current capture, at most 20 items with truncation marked. `COMPLETE` means only that the listed scope was verified; no change does not prove factual correctness. `UNVERIFIED` means part or all could not be verified, and confirmed changes are still listed. A contract-check failure keeps the original rejection path; everything else stays unverified — the check is not bypassed to fabricate a comparison, and score changes are not attributed from it.

## Native result card (legacy DSH replay)

B2 status uses Chinese text in the same area, without the legacy Python fields or refresh controls.

Hosts supporting `tool.call.toolview` show a dark, gold-accented Chinese result card: current three-state verdict, next step, a "re-check" button and collapsible basis. The button only reads status; it cannot replay or register completion. Without a card interface, the Chinese tool text is kept.

The collapsible basis contains the Chinese reason, receipt thresholds, Node / Python / pandas versions, plus input path, byte count and the first 12 characters of SHA-256; missing values stay unknown. These describe the environment bound by the receipt; current validity still comes from this check.

The section also lists binding changes and unverified notes; when the original replay had a confirmable archive anomaly location, it is shown and labelled as a historical diagnostic. Version information describes the gate replay environment and does not stand in for the original model evaluation environment.

Opening the card re-checks under the same explicit threshold/baseline policy and never displays a historical PASS directly; load failure, invalid policy, missing session binding or incomplete protocol all become needs-review. The display represents only the moment of that check, does not watch files continuously, and can be checked again before use. The native card offers no path settings panel.

## Legacy replay: three states and decision rules

The plugin reads an existing evaluation result, runs the gate, and returns PASS, FAIL or REVIEW:

| Current state | `gate_passed` | Meaning |
|---|---|---|
| PASS | `true` | Python passed, receipt complete, checked bindings unchanged |
| FAIL | `false` | Python explicitly blocked, receipt complete, current bindings unchanged |
| REVIEW | `null` | Input, dependency, receipt or execution incomplete; or bindings changed; or protocol conflict |

After a confirmed FAIL, the core FAIL is preserved even if writing the receipt fails; a later status shows needs-review because no complete receipt exists. The original report's FAIL record remains readable and unverifiable historical fields stay unknown. Python exiting 1 with only a traceback is still REVIEW.

## Output and data boundaries

Legacy replay records live in `<state root>/runs/<run_id>/` and contain `report.json`, stdout, stderr and, when eligible, `receipt.json`; completion registrations are stored separately under `completions/`. B2 instead stores report, original input, policy, normalized data and ReceiptV2, with no fake stdout/stderr. Appended records never overwrite failures. Logs may contain archive fragments and local paths — redact before sharing. The plugin uploads no archives and prints no full environment.

Records are retained indefinitely by default; there is no automatic cleanup. With an explicit `VERISCOPE_STATE_DIR`, `node scripts/prune.mjs --dry-run --json` only previews file inventory, logical byte counts, and recorded relationships. It neither verifies those relationships nor offers deletion. Keep persistent state outside the plugin directory before uninstalling or reinstalling.

Input is limited to 10 MiB, stdout / stderr to 2 MiB each, replay to 120 seconds and each environment probe to 10 seconds. ReceiptV1 status reads and hashes files and starts Python to read versions and pandas metadata; it runs neither the evaluation model nor the gate script. Hashes do not prove semantic correctness, and a user who can rewrite the whole state root is out of scope; changes after a check are only found by checking again.

The historical trace only verifies literal source positions and is labelled `historical_ai`; it is not a new semantic check. The core makes zero new evaluation-model calls, though host conversation may still cost tokens. No claim of algorithmic originality or end-to-end cost reduction is made.

## Verification and maintenance

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

Unit tests use constructed archives and protocol stubs; they need neither a model nor Python. Real Python and host acceptance are covered in the [verification notes](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/verification.md). Uninstalling removes the registration. The plugin does not delete external state roots, but package-local state may be lost on removal or reinstall; back it up first. Publishing from source requires explicitly setting `VERISCOPE_RELEASE=1` and passing the version/tag guard; see the contributing guide.

## Contributing and license

[Contributing](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CONTRIBUTING.md) · [Governance](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/GOVERNANCE.md) · [Changelog](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CHANGELOG.md) · [Roadmap](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/ROADMAP.md) · [Security](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/SECURITY.md) · [Release checklist](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RELEASE_CHECKLIST.md). Not listed in the marketplace until that PR merges.

MIT, retaining the original scaffold copyright; see [third-party notices](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/THIRD_PARTY_NOTICES.md) and [provenance hashes](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/provenance.json). Upstream is distributed separately under its own license.
