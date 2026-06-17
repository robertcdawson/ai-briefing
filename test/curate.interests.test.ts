import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_INTEREST_PROFILE, getInterestProfile } from "../src/interests.js";
import { buildInterestProfileBlock, buildSystemPrompt } from "../src/curate.js";

function withEnv(value: string | undefined, fn: () => void): void {
  const had = Object.prototype.hasOwnProperty.call(process.env, "INTEREST_PROFILE");
  const prev = process.env.INTEREST_PROFILE;
  if (value === undefined) delete process.env.INTEREST_PROFILE;
  else process.env.INTEREST_PROFILE = value;
  try {
    fn();
  } finally {
    if (had) process.env.INTEREST_PROFILE = prev;
    else delete process.env.INTEREST_PROFILE;
  }
}

test("getInterestProfile returns the committed default when INTEREST_PROFILE is unset", () => {
  withEnv(undefined, () => {
    const p = getInterestProfile();
    assert.equal(p, DEFAULT_INTEREST_PROFILE.trim());
    assert.match(p, /developer AI products/i);
    assert.match(p, /human augmentation/i);
  });
});

test("getInterestProfile honors a non-empty INTEREST_PROFILE override", () => {
  withEnv("only quantum computing news", () => {
    assert.equal(getInterestProfile(), "only quantum computing news");
  });
});

test("getInterestProfile returns empty string when override is blank (personalization disabled)", () => {
  withEnv("   ", () => {
    assert.equal(getInterestProfile(), "");
  });
});

test("buildInterestProfileBlock returns empty string for an empty profile", () => {
  assert.equal(buildInterestProfileBlock(""), "");
  assert.equal(buildInterestProfileBlock("   "), "");
});

test("buildInterestProfileBlock includes the profile text and the major-news floor", () => {
  const block = buildInterestProfileBlock("consumer AI products");
  assert.match(block, /consumer AI products/);
  // weighting, not filtering
  assert.match(block, /never as a filter/i);
  // the floor that defends against a filter bubble
  assert.match(block, /REGARDLESS/);
  assert.match(block, /never bury big news/i);
});

test("buildSystemPrompt injects the interest block when a profile is provided", () => {
  const prompt = buildSystemPrompt("developer AI products and tooling");
  assert.match(prompt, /LISTENER INTEREST PROFILE/);
  assert.match(prompt, /developer AI products and tooling/);
  assert.match(prompt, /REGARDLESS/);
});

test("buildSystemPrompt is behavior-neutral when no profile is provided", () => {
  const withoutProfile = buildSystemPrompt();
  const explicitlyEmpty = buildSystemPrompt("");
  assert.doesNotMatch(withoutProfile, /LISTENER INTEREST PROFILE/);
  // default-arg and explicit-empty produce identical prompts
  assert.equal(withoutProfile, explicitlyEmpty);
});
