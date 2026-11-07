import assert from 'node:assert/strict';
import test from 'node:test';
import { readSandboxBranchActivities, assertSandboxPublicationActivities } from './lib/bridge-sandbox-activity.mjs';

const repository = 'osborn-studio/osstack-bridge-sandbox', repositoryId = 1446327922;
const branch = 'osstack/mission/activity-test', ref = `refs/heads/${branch}`, publisherActorId = 352680398;
const sha = value => value.repeat(40);
const scope = { repository, repositoryId, branch };
const intent = (intent_id, kind, oldHead, newHead) => ({ intent_id, kind, state: 'confirmed', repository, branch,
  chain_id: 'chain', pr_number: 7, expected_old_head: oldHead, new_head: newHead });
const intents = [intent('baseline', 'open_pr', sha('a'), sha('1')), intent('revision', 'push', sha('1'), sha('2'))];
const event = (id, activity_type, before, after) => ({ id, activity_type, before, after, ref, actor: { id: publisherActorId, type: 'Bot', login: 'ignored' }, private_field: 'must-not-escape' });
const activities = [event(12, 'push', sha('1'), sha('2')), event(11, 'branch_creation', sha('0'), sha('1'))];
const verify = (over = {}) => assertSandboxPublicationActivities({ ...scope, publisherActorId, intents, activities, ...over });

test('reads exactly one fixed sandbox/ref/day page without filtering away wrong actors', async () => {
  const calls = [], signal = new AbortController().signal;
  const result = await readSandboxBranchActivities({ ...scope, signal, get: async (...args) => { calls.push(args); return activities; } });
  assert.deepEqual(calls, [[`repos/${repository}/activity?per_page=100&ref=${encodeURIComponent(ref)}&time_period=day`, { signal }]]);
  assert.equal(result.length, 2); assert.equal(result[0].private_field, undefined); assert.equal(result[0].actor.login, undefined);
  const foreign = structuredClone(activities); foreign[0].actor.id = 99;
  assert.equal((await readSandboxBranchActivities({ ...scope, get: async () => foreign }))[0].actor.id, 99);
});

test('matches creation and revisions by exact range, returns only evidence fields in chain order', () => {
  assert.deepEqual(verify(), [
    { intent_id: 'baseline', activity_id: 11, activity_type: 'branch_creation', actor: { id: publisherActorId, type: 'Bot' }, ref, before: sha('0'), after: sha('1') },
    { intent_id: 'revision', activity_id: 12, activity_type: 'push', actor: { id: publisherActorId, type: 'Bot' }, ref, before: sha('1'), after: sha('2') },
  ]);
  assert.deepEqual(verify({ intents: [...intents].reverse() }), verify());
});

test('rejects a full page instead of pretending pagination is complete', async () => {
  await assert.rejects(readSandboxBranchActivities({ ...scope, get: async () => Array.from({ length: 100 }, (_, i) => ({ ...activities[0], id: i + 1 })) }), /activity_read_incomplete/);
});

test('refuses malformed and out-of-scope inputs before any GET', async () => {
  let calls = 0; const get = async () => { calls++; return []; };
  for (const over of [{ repository: 'osborn-studio/osstack' }, { repositoryId: 1 }, { branch: 'main' }, { branch: 'osstack/mission/../main' },
    { branch: 'osstack/mission/a\n../main' }, { branch: 'osstack/mission/x?actor=bad' }, { branch: 'osstack/mission/x.lock' }]) {
    await assert.rejects(readSandboxBranchActivities({ ...scope, ...over, get }), /activity_scope_invalid/);
  }
  assert.equal(calls, 0);
});

test('refuses wrong actor/type, force pushes, duplicate/ambiguous and missing events', () => {
  for (const [mutate, code] of [
    [rows => { rows[0].actor.id = 99; }, 'activity_actor_mismatch'],
    [rows => { rows[0].actor.type = 'User'; }, 'activity_actor_mismatch'],
    [rows => { rows[0].activity_type = 'force_push'; }, 'activity_force_push'],
    [rows => { rows.push({ ...rows[0], id: 13 }); }, 'activity_ambiguous'],
    [rows => { rows.push({ ...rows[0] }); }, 'activity_ambiguous'],
    [rows => { rows.pop(); }, 'activity_missing'],
    [rows => { rows[0].before = sha('a'); }, 'activity_missing'],
    [rows => { rows[1].before = sha('a'); }, 'activity_missing'],
    [rows => { rows.push(event(13, 'push', sha('2'), sha('3'))); }, 'activity_unmatched'],
  ]) {
    const rows = structuredClone(activities); mutate(rows);
    assert.throws(() => verify({ activities: rows }), new RegExp(code));
  }
});

test('rejects malformed SHAs/records and intent scope or chain ambiguity', () => {
  for (const over of [{ publisherActorId: 0 }, { publisherActorId: 1.5 }, { intents: [] },
    { intents: [...intents, { ...intents[0], intent_id: 'duplicate-baseline' }] },
    { intents: [intents[0], { ...intents[1], repository: 'other/repo' }] },
    { intents: [intents[0], { ...intents[1], chain_id: 'other' }] },
    { intents: [intents[0], { ...intents[1], pr_number: 8 }] },
    { intents: [intents[0], { ...intents[1], new_head: 'bad' }] },
    { activities: [{ ...activities[0], after: sha('f').toUpperCase() }, activities[1]] },
    { activities: [{ ...activities[0], ref: 'refs/heads/main' }, activities[1]] },
    { activities: [{ ...activities[0], id: Number.MAX_SAFE_INTEGER + 1 }, activities[1]] },
    { activities: [{ ...activities[0], actor: null }, activities[1]] }]) assert.throws(() => verify(over), /activity_/);
});

test('64-character hashes use matching-width zero creation and exact push before/after', () => {
  const longIntents = intents.map(i => ({ ...i, expected_old_head: i.expected_old_head[0].repeat(64), new_head: i.new_head[0].repeat(64) }));
  const longActivities = activities.map(e => ({ ...e, before: e.before[0].repeat(64), after: e.after[0].repeat(64) }));
  assert.equal(verify({ intents: longIntents, activities: longActivities }).length, 2);
  longActivities[1].before = sha('0');
  assert.throws(() => verify({ intents: longIntents, activities: longActivities }), /activity_missing/);
});

test('abort wins over a late successful page and transport errors reveal no response text', async () => {
  const abort = new AbortController(); const reason = Error('cancelled');
  await assert.rejects(readSandboxBranchActivities({ ...scope, signal: abort.signal, get: async () => { abort.abort(reason); return activities; } }), error => error === reason);
  await assert.rejects(readSandboxBranchActivities({ ...scope, get: async () => { throw Error('private-token-or-remote-error'); } }), error => error.message === 'activity_read_failed');
  await assert.rejects(readSandboxBranchActivities({ ...scope, get: async () => ({ incomplete: true }) }), /activity_response_invalid/);
});
