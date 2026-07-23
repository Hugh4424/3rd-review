# workflowhub-result.v2 public contract

## Purpose

`workflowhub-result.v2` is the public 3rd-review result consumed by
WorkflowHub. It exposes only broker-safe execution facts. It never grants
access to the runtime directory, provider working directory, raw output files,
or native session files.

## Request

Use a v4 broker request with `required_result_protocol: "workflowhub-result.v2"`
and a non-empty `provider_allowlist` candidate group of configured profile IDs.
The broker owns group dispatch: it keeps the caller's group order and starts
at most one candidate per CLI adapter in parallel. The first heterologous
candidate for an adapter is eligible to run; a host-adapter candidate and each
later candidate with an already selected adapter are not request errors. They
are returned as public failed results with `error.code: "SAME_SOURCE"`, without
starting that CLI. The same selection applies to initial and continuation
rounds. This lets WorkflowHub request multiple review perspectives without
duplicating 3rd-review's adapter isolation, workspace, attachment, retry, and
native-session handling.

Like v1, every initial or continuation round requires a complete sealed
attachment bundle. The broker rejects an unsupported protocol before creating a
runtime or starting a provider.

## Provider result

Every returned provider result has these fields:

    provider, adapter, model, effort, thinking
    status, result_protocol, material_id
    runtime_id, session_id, session_file_path, continuable
    timing.started_at_ms, timing.completed_at_ms, timing.duration_ms
    usage
    retry.count, retry.progress_events
    raw_output_ref
    unavailable_diagnostics
    output, error

- `model`, `effort`, and `thinking` are the selected trusted profile's
  invocation facts. They are `null` when that profile does not declare one.
- Each `timing` member is a non-negative integer when the broker observed it;
  otherwise it is `null`.
- `usage` is provider-parsed usage only. It is `null` when the provider did
  not return usage; packet size is not substituted as usage.
- `session_file_path` is always `null`. `runtime_id` and `session_id` are
  opaque identifiers, not filesystem paths.
- `raw_output_ref` is either `null` or a logical reference containing the
  runtime ID, provider ID, and stdout/stderr SHA-256 digests. It is a
  correlation reference, not a readable path or fetch capability.
- `unavailable_diagnostics` is `null` for a completed result. Otherwise it
  contains only the public error code and message, including `SAME_SOURCE` for
  a candidate excluded by host-adapter isolation or a later same-adapter group
  candidate.

The broker validates this exact provider projection before publishing it. An
undocumented field, a non-null `session_file_path`, invalid timing/retry shape,
or an absolute host path is rejected. A provider error that includes an
absolute host path retains its stable error code but replaces the message with
the fixed public redaction text.

`status: "skipped"` is normalized to `"failed"` in both WorkflowHub public
protocols so a route cannot treat a skipped review as a successful result.

## Compatibility and privacy

`workflowhub-result.v1` remains supported with its exact seven-field provider
projection. `doctor.result_protocols` advertises both versions. Consumers must
select a version explicitly and must not read broker-private runtime state to
fill absent fields.
