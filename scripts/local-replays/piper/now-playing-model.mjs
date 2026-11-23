import assert from "node:assert/strict";

// Model the decisions in the referenced Go code. This does not execute Piper.
function fixture({ enforceOwnership = false, retainUntilCleared = false } = {}) {
  let current = null;
  let lastSeen = null;
  let clearCalls = 0;
  const publish = (source, song) => { current = { source, song }; };
  function clear(source, fail) {
    if (enforceOwnership && current?.source !== source) return;
    clearCalls++;
    if (fail) throw new Error("temporary repository error");
    current = null;
  }
  function pollListenBrainz(song, fail = false) {
    if (!song) {
      const hadPublished = lastSeen !== null;
      if (!retainUntilCleared) lastSeen = null;
      if (hadPublished) clear("listenbrainz", fail);
      lastSeen = null;
    } else if (lastSeen !== song) {
      lastSeen = song;
      publish("listenbrainz", song);
    }
  }
  return { pollListenBrainz, clear, get current() { return current; }, get clearCalls() { return clearCalls; } };
}

const currentBehavior = fixture();
currentBehavior.pollListenBrainz("a");
currentBehavior.clear("apple");
currentBehavior.pollListenBrainz("a");
assert.equal(currentBehavior.current, null);

const ownedStatus = fixture({ enforceOwnership: true });
ownedStatus.pollListenBrainz("a");
ownedStatus.clear("apple");
ownedStatus.pollListenBrainz("a");
assert.deepEqual(ownedStatus.current, { source: "listenbrainz", song: "a" });

const clearFailure = fixture();
clearFailure.pollListenBrainz("a");
assert.throws(() => clearFailure.pollListenBrainz(null, true), /temporary repository error/);
clearFailure.pollListenBrainz(null);
assert.equal(clearFailure.clearCalls, 1);
assert.equal(clearFailure.current?.song, "a");

const retryable = fixture({ retainUntilCleared: true });
retryable.pollListenBrainz("a");
assert.throws(() => retryable.pollListenBrainz(null, true), /temporary repository error/);
retryable.pollListenBrainz(null);
assert.equal(retryable.clearCalls, 2);
assert.equal(retryable.current, null);

console.log("Model reproduced cross-source clear and a failed clear that was not retried.");
console.log("Source ownership and retaining clear state until success each prevented their modeled failure.");
