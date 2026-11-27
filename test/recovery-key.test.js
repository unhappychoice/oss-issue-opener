import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRecoveryCheckKey, recoveryCheckKey } from '../dist/recovery-key.js';

test('recoveryCheckKey keys a check-source identity by its workflow id', () => {
  const key = recoveryCheckKey({ name: 'build', source: 'check', workflowId: 10 });
  assert.notEqual(key, undefined);
  assert.equal(key, recoveryCheckKey({ name: 'build', source: 'check', workflowId: 10 }));
});

test('recoveryCheckKey keys a status-source identity by its publisher id', () => {
  const key = recoveryCheckKey({ name: 'lint', source: 'status', publisherId: 42 });
  assert.notEqual(key, undefined);
  assert.equal(key, recoveryCheckKey({ name: 'lint', source: 'status', publisherId: 42 }));
});

test('recoveryCheckKey is undefined when the relevant id for the source is missing', () => {
  assert.equal(recoveryCheckKey({ name: 'build', source: 'check', publisherId: 10 }), undefined);
  assert.equal(recoveryCheckKey({ name: 'lint', source: 'status', workflowId: 42 }), undefined);
});

test('recoveryCheckKey is undefined for a non-positive or non-integer id', () => {
  assert.equal(recoveryCheckKey({ name: 'build', source: 'check', workflowId: 0 }), undefined);
  assert.equal(recoveryCheckKey({ name: 'build', source: 'check', workflowId: -1 }), undefined);
  assert.equal(recoveryCheckKey({ name: 'build', source: 'check', workflowId: 1.5 }), undefined);
});

test('recoveryCheckKey normalizes a status check name case-insensitively', () => {
  const lower = recoveryCheckKey({ name: 'lint', source: 'status', publisherId: 42 });
  const upper = recoveryCheckKey({ name: 'LINT', source: 'status', publisherId: 42 });
  assert.equal(lower, upper);
});

test('recoveryCheckKey keeps a check name case-sensitive, since only status contexts are case-insensitive', () => {
  const lower = recoveryCheckKey({ name: 'build', source: 'check', workflowId: 10 });
  const upper = recoveryCheckKey({ name: 'BUILD', source: 'check', workflowId: 10 });
  assert.notEqual(lower, upper);
});

test('normalizeRecoveryCheckKey leaves a key that is not base64url-encoded JSON unchanged', () => {
  assert.equal(normalizeRecoveryCheckKey('not-a-valid-key'), 'not-a-valid-key');
});

test('normalizeRecoveryCheckKey leaves a decodable key with the wrong shape unchanged', () => {
  const wrongLength = Buffer.from(JSON.stringify(['status', 'lint'])).toString('base64url');
  const notAnArray = Buffer.from(JSON.stringify({ source: 'status', name: 'lint' })).toString('base64url');
  const wrongSource = Buffer.from(JSON.stringify(['check', 'build', 10])).toString('base64url');

  assert.equal(normalizeRecoveryCheckKey(wrongLength), wrongLength);
  assert.equal(normalizeRecoveryCheckKey(notAnArray), notAnArray);
  assert.equal(normalizeRecoveryCheckKey(wrongSource), wrongSource);
});
