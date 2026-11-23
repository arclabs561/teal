import assert from "node:assert/strict";
import { resolve } from "node:path";

const before = [];
const after = [];
const tests = [];
const mocks = [];
globalThis.__dirname = resolve("apps/amethyst/lib/__tests__");
globalThis.beforeAll = (fn) => before.push(fn);
globalThis.afterEach = (fn) => after.push(fn);
globalThis.describe = (_name, fn) => fn();
globalThis.it = {
  each: (rows) => (name, fn) => rows.forEach((row) => tests.push([name.replace("$name", row.name), () => fn(row)])),
  todo: (name) => console.log("TODO", name),
};
globalThis.jest = {
  spyOn: (target, field) => {
    const original = target[field];
    mocks.push(() => { target[field] = original; });
    return {
      mockImplementation(fn) {
        const spy = (...args) => {
          spy.calls++;
          return fn(...args);
        };
        spy.calls = 0;
        target[field] = spy;
        return spy;
      },
    };
  },
  restoreAllMocks: () => { while (mocks.length) mocks.pop()(); },
};
globalThis.expect = (actual) => ({
  toEqual(expected) { assert.deepEqual(actual, expected); },
  toBe(expected) { assert.equal(actual, expected); },
  toHaveBeenCalledTimes(expected) { assert.equal(actual.calls, expected); },
});

await import("./apps/amethyst/lib/__tests__/musicbrainzPublicReplay.test.ts");
for (const fn of before) await fn();
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log("PASS", name);
  } finally {
    for (const cleanup of after) await cleanup();
  }
}
assert.equal(tests.length, 3);
