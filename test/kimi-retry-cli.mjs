#!/usr/bin/env node

console.error("APIEmptyResponseError: empty response");
console.error("APIEmptyResponseError: empty response");
console.log(JSON.stringify({ type: "thinking", session_id: "kimi-retry-session", content: "reasoning" }));
setTimeout(() => console.log(JSON.stringify({ type: "final", session_id: "kimi-retry-session", text: "kimi opinion" })), 20);
