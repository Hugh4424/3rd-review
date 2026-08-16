# workflowhub-result.v3

`workflowhub-result.v3` is the additive public result protocol for WorkflowHub.
The existing v1 and v2 projections remain unchanged and remain readable by
their existing consumers.

The broker owns provider execution. A v3 group contains one member for every
configured profile in the submitted candidate group. A member is terminal on
its own; one successful member is not rerun because another member failed.
`completed`, `partial`, `unavailable`, and `cancelled` are aggregate facts, not
stage completion permissions.

Each member exposes safe profile identity, material/contract identity, the
positive configured deadline, timing, provider usage (or `null`), every broker
attempt, and three separate recovery counters:

- `provider_internal_retry_count`
- `fresh_execution_retry_count` (at most one)
- `same_session_repair_count` (at most one)

Raw output and session paths stay private. Public provenance contains only the
runtime identifier and output digests. A v2 member or group is rejected as a
mixed-version result; callers must explicitly request the protocol they consume.

Recovery is classified once by the broker: configuration/authentication,
packet, and timeout errors do not recover; startup/death/recoverable transport
errors may receive one fresh execution; output syntax/schema errors may receive
one same-session repair. WorkflowHub does not add another retry layer.
