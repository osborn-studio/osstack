// Deliberately sandbox-only: this evidence reader never supplies credentials or writes.
const repositoryName = 'osborn-studio/osstack-bridge-sandbox';
const sandboxId = 1446327922;
const fail = code => { throw new Error(code); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
function scope(options) {
  const { repository, repositoryId, branch } = options;
  if (repository !== repositoryName || repositoryId !== sandboxId || typeof branch !== 'string' ||
      branch.length > 255 || !/^osstack\/mission\/[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) ||
      branch.includes('..') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) fail('activity_scope_invalid');
  return `refs/heads/${branch}`;
}
function rows(value, ref) {
  if (!Array.isArray(value)) fail('activity_response_invalid');
  if (value.length >= 100) fail('activity_read_incomplete');
  return value.map(row => {
    if (!row || !positiveId(row.id) || typeof row.activity_type !== 'string' || row.ref !== ref ||
        !hash(row.before) || !hash(row.after) || !positiveId(row.actor?.id) ||
        !['Bot', 'User'].includes(row.actor.type)) fail('activity_response_invalid');
    return { id: row.id, activity_type: row.activity_type, actor: { id: row.actor.id, type: row.actor.type }, ref, before: row.before, after: row.after };
  });
}
export async function readSandboxBranchActivities(options) {
  const ref = scope(options);
  const { signal, get } = options;
  if (typeof get !== 'function') fail('activity_scope_invalid');
  signal?.throwIfAborted();
  let response;
  try {
    response = await get(`repos/${repositoryName}/activity?per_page=100&ref=${encodeURIComponent(ref)}&time_period=day`, { signal });
  } catch {
    signal?.throwIfAborted();
    fail('activity_read_failed');
  }
  signal?.throwIfAborted();
  return rows(response, ref);
}
export function assertSandboxPublicationActivities(options) {
  const ref = scope(options);
  const { publisherActorId, intents } = options;
  if (!positiveId(publisherActorId) || !Array.isArray(intents) || !intents.length || intents.length > 100) fail('activity_intents_invalid');
  const first = intents[0];
  const ids = new Set();
  for (const intent of intents) {
    if (!intent || intent.repository !== options.repository || intent.branch !== options.branch ||
        typeof intent.intent_id !== 'string' || !intent.intent_id || ids.has(intent.intent_id) ||
        typeof intent.chain_id !== 'string' || !intent.chain_id || intent.chain_id !== first.chain_id ||
        !positiveId(intent.pr_number) || intent.pr_number !== first.pr_number ||
        !hash(intent.expected_old_head) || !hash(intent.new_head) ||
        intent.expected_old_head.length !== intent.new_head.length || /^0+$/.test(intent.new_head)) fail('activity_intents_invalid');
    ids.add(intent.intent_id);
  }
  const confirmed = intents.filter(intent => intent.state === 'confirmed' && ['open_pr', 'push'].includes(intent.kind));
  const baseline = confirmed.filter(intent => intent.kind === 'open_pr');
  if (baseline.length !== 1) fail('activity_intents_invalid');
  const ordered = [baseline[0]], remaining = confirmed.filter(intent => intent.kind === 'push');
  while (remaining.length) {
    const next = remaining.filter(intent => intent.expected_old_head === ordered.at(-1).new_head);
    if (next.length !== 1) fail('activity_intents_invalid');
    ordered.push(next[0]); remaining.splice(remaining.indexOf(next[0]), 1);
  }
  const activities = rows(options.activities, ref), activityIds = new Set();
  for (const activity of activities) {
    if (activity.activity_type === 'force_push') fail('activity_force_push');
    if (activity.actor.id !== publisherActorId || activity.actor.type !== 'Bot') fail('activity_actor_mismatch');
    if (activityIds.has(activity.id)) fail('activity_ambiguous');
    activityIds.add(activity.id);
  }
  const used = new Set();
  const evidence = ordered.map(intent => {
    const type = intent.kind === 'open_pr' ? 'branch_creation' : 'push';
    const before = intent.kind === 'open_pr' ? '0'.repeat(intent.new_head.length) : intent.expected_old_head;
    const matches = activities.filter(activity => activity.activity_type === type && activity.before === before && activity.after === intent.new_head);
    if (matches.length > 1) fail('activity_ambiguous');
    if (matches.length !== 1 || used.has(matches[0].id)) fail('activity_missing');
    const activity = matches[0]; used.add(activity.id);
    return { intent_id: intent.intent_id, activity_id: activity.id, activity_type: activity.activity_type, actor: activity.actor, ref, before: activity.before, after: activity.after };
  });
  if (used.size !== activities.length) fail('activity_unmatched');
  return evidence;
}
