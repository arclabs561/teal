import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const evidence = JSON.parse(await readFile(new URL("./artist-credit-checks.json", import.meta.url)));
const results = new Map(evidence.searches.map((row) => [row.name, row.data]));

assert.equal(results.get("cosmic combined").count, 0);
assert.equal(results.get("cosmic separate").rows[0][0], "d3247aab-6e9e-4016-8947-156d59a62542");

for (const [key, artist] of [["earth", "Earth, Wind & Fire"], ["tyler", "Tyler, The Creator"]]) {
  const combined = results.get(key + " combined").rows[0];
  const split = results.get(key + " split").rows[0];
  assert.deepEqual(combined[3], [artist]);
  assert.deepEqual(split[3], [artist]);
  assert.notEqual(combined[0], split[0]);
}
for (const row of evidence.repeatCaptures) {
  assert.equal(row.created, results.get(row.name).created);
}
console.log(evidence.sample);
console.log("Cosmic War recovered with separate credits. For two intact names, splitting changed the first candidate in the captured responses.");
console.log("Repeat requests returned the same captures. They do not test live ranking stability.");
