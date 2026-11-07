import assert from "node:assert/strict";
import test from "node:test";
import { selectBetaBaseVersion } from "../../scripts/lib/beta-release-plan.js";
test("beta base selection rejects missing, ambiguous, prerelease, and non-forward plans", () => {
  assert.equal(
    selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0" }] }, "0.14.2"),
    "1.0.0",
  );
  assert.throws(() => selectBetaBaseVersion({ releases: [] }, "0.14.2"), /pending Changeset release/);
  assert.throws(
    () => selectBetaBaseVersion({
      releases: [
        { name: "oh-my-space", newVersion: "1.0.0" },
        { name: "oh-my-space", newVersion: "1.1.0" },
      ],
    }, "0.14.2"),
    /expected exactly one/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0-beta.1" }] }, "0.14.2"),
    /non-stable/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "1.0.0+build.1" }] }, "0.14.2"),
    /non-stable/,
  );
  assert.throws(
    () => selectBetaBaseVersion({ releases: [{ name: "oh-my-space", newVersion: "0.14.2" }] }, "0.14.2"),
    /must be greater/,
  );
});
