#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result", subtype: "error_during_execution", is_error: true,
  api_error_status: 529, terminal_reason: "api_error", stop_reason: "error",
  duration_api_ms: 1234, num_turns: 2,
  permission_denials: [{ code: "Read", message: "denied token=super-secret-value", tool_input: { file_path: "/private/materials.md" } }],
  errors: [{ code: "overloaded", message: "service unavailable sk-live-secretvalue" }],
  result: "PRIVATE RESULT CONTENT", structured_output: { prompt: "PRIVATE PROMPT", materials: "PRIVATE MATERIALS" },
}));
process.exit(1);
