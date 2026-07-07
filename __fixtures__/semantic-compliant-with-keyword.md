## Review Persist Design

The design persists reviewer_output via an attest record bound to the specific
spawned subprocess session id. Self-attest is explicitly forbidden: the same
agent that produces the work can never satisfy its own attest gate — every
attest must come from an independent verifier process, never the same principal.
