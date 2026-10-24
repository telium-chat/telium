import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, validatePing } from "../src/validate.js";

test("a well-formed ping passes and carries only its two fields", () => {
  assert.deepEqual(validatePing({ id: "01HQexample_id-42", users: 41 }), {
    id: "01HQexample_id-42",
    users: 41,
  });
});

test("anything that is not exactly {id, users} is refused", () => {
  for (const body of [
    null,
    "01HQ",
    41,
    [],
    {},
    { id: "x" },
    { users: 1 },
    { id: "x", users: 1, extra: true },
  ]) {
    assert.equal(validatePing(body), null, JSON.stringify(body));
  }
});

test("an id is 1-64 url-safe characters, no more", () => {
  for (const id of ["", "x".repeat(65), "has space", "slash/x", 'quote"', "dot.name"]) {
    assert.equal(validatePing({ id, users: 0 }), null, JSON.stringify(id));
  }
  assert.ok(validatePing({ id: "x".repeat(64), users: 0 }));
});

test("users is a whole number from 0 to the ceiling", () => {
  for (const users of [-1, 1.5, "3", NaN, Number.MAX_SAFE_INTEGER + 1, 10_000_001]) {
    assert.equal(validatePing({ id: "x", users }), null, String(users));
  }
  assert.ok(validatePing({ id: "x", users: 0 }));
  assert.ok(validatePing({ id: "x", users: 10_000_000 }));
});

test("the aggregate is the two numbers the project wants", () => {
  assert.deepEqual(aggregate([]), { servers: 0, users: 0 });
  assert.deepEqual(aggregate([{ users: 10 }, { users: 3 }, { users: 0 }]), {
    servers: 3,
    users: 13,
  });
  assert.deepEqual(aggregate([{ users: undefined }, { users: 7 }]), {
    servers: 2,
    users: 7,
  });
});
