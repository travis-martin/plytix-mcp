import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateChangeRecord } from './change-record.mjs';

const policy = JSON.parse(readFileSync(new URL('../.change-record-policy.json', import.meta.url), 'utf8'));
const valid = `feat(history): retain committed knowledge revisions\n\nChange-Id: change-20261118-history\nReason: Preserve source-linked revisions for rollback.\nSources: reviewed issue 123\nValidation: fixture replay passed on local and GCS stores\nRollback: Revert the code commit; restore data through a reviewed new revision.`;
test('same factual record is accepted on Unix and Windows', () => {
  assert.deepEqual(validateChangeRecord(valid, policy), []);
  assert.deepEqual(validateChangeRecord(valid.replaceAll('\n', '\r\n'), policy), []);
});
test('empty, duplicate, body-only and placeholder evidence cannot satisfy the standard', () => {
  for (const message of [valid.replace('Sources: reviewed issue 123', 'Sources:'), valid + '\nReason: duplicate', valid.replace('Validation:', 'Validation draft:'), valid.replace('reviewed issue 123', 'replace-with-evidence'), 'fix: update history\n\n' + valid.split('\n\n')[1]]) {
    assert.ok(validateChangeRecord(message, policy).length > 0, message);
  }
});
test('template is deliberately invalid until meaningful review evidence is entered', () => {
  assert.ok(validateChangeRecord(readFileSync(new URL('../.gitmessage', import.meta.url), 'utf8'), policy).length > 0);
});
