import assert from "node:assert/strict";
import test from "node:test";
import { failureCode, failureMessage } from "../lib/provider-failure.mjs";

test("provider usage and billing failures are classified as non-retryable rate limits", () => {
  for (const stderr of [
    "HTTP 403 usage limit reached",
    "usage limit reached for the current billing cycle",
    "credits exhausted",
    "spending limit exceeded",
  ]) {
    assert.equal(failureCode(stderr), "RATE_LIMITED", stderr);
    assert.equal(failureMessage(failureCode(stderr)), "provider rate limit was reached");
  }
});

test("authentication failures remain distinct from generic forbidden responses", () => {
  assert.equal(failureCode("HTTP 403 forbidden: invalid API key"), "AUTHENTICATION_FAILED");
  assert.equal(failureCode("HTTP 403 forbidden"), "PROCESS_EXIT_NONZERO");
});
