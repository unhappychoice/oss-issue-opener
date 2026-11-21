import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConcurrencyLimiter } from '../dist/concurrency-limiter.js';

test('hands off a slot to queued tasks in arrival order', async () => {
  const run = createConcurrencyLimiter(1);
  const started = [];
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers());
  const submit = (index) => run(() => {
    started.push(index);
    return gates[index].promise;
  });

  const first = submit(0);
  const second = submit(1);
  const third = submit(2);
  assert.deepEqual(started, [0]);

  gates[0].resolve('first');
  assert.equal(await first, 'first');
  assert.deepEqual(started, [0, 1]);

  gates[1].resolve('second');
  assert.equal(await second, 'second');
  assert.deepEqual(started, [0, 1, 2]);

  gates[2].resolve('third');
  assert.equal(await third, 'third');
});

test('forwards a rejection and releases the slot for the next task', async () => {
  const run = createConcurrencyLimiter(1);
  const gate = Promise.withResolvers();
  const error = new Error('Lookup failed');
  const first = run(() => gate.promise);
  const rejected = assert.rejects(first, (cause) => cause === error);
  let started = false;
  const next = run(async () => {
    started = true;
    return 'recovered';
  });
  assert.equal(started, false);

  gate.reject(error);
  await rejected;
  assert.equal(await next, 'recovered');
  assert.equal(await run(async () => 'available'), 'available');
});
