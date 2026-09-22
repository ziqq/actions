const assert = require('node:assert/strict');
const test = require('node:test');

const labeler = require('../dist/index.js');

function config(overrides = {}) {
  return {
    schema: 4,
    labels: {
      bug: {
        name: 'Defect from users',
        color: 'd73a4a',
        description: 'Something is not working.',
        previousNames: ['bug'],
        paths: ['lib/**'],
      },
      completed: {
        name: 'Shipped anywhere',
        color: '0e8a16',
        description: 'Published.',
      },
      in_progress: {
        name: 'Currently building',
        color: 'ffffff',
        description: 'Work is active.',
      },
      waiting_for_release: {
        name: 'Queue for publication',
        color: '0e8a16',
        description: 'Ready to publish.',
      },
    },
    references: {
      branchIssuePattern: 'github-(\\d+)',
      closingIssuePattern: '(?:close[sd]?|fixe[sd]?)\\s+#(\\d+)',
    },
    transitions: {
      finish: {
        add: ['completed'],
        remove: [],
        removeIdPatterns: ['*_progress', 'waiting_*'],
      },
      start: {
        add: ['in_progress'],
        remove: ['completed', 'waiting_for_release'],
      },
    },
    events: {
      issueCommented: {
        transition: 'start',
        allowedActors: ['issue-author', 'assignee'],
        requireLabels: ['waiting_for_release'],
      },
      releasePublished: {
        transition: 'finish',
        selector: {
          all: ['waiting_for_release'],
          any: ['bug', 'in_progress'],
          not: ['completed'],
          state: 'all',
        },
      },
    },
    sync: {
      excludeNamePatterns: ['system:*'],
      managedNamePatterns: ['*'],
      orphanPolicy: 'keep',
    },
    ...overrides,
  };
}

test('GitHub action input names preserve hyphens', () => {
  const inputs = labeler.buildInputs({
    'INPUT_ALLOW-EMPTY': 'true',
    'INPUT_CONFIG-SOURCE': 'workspace',
    'INPUT_DRY-RUN': 'true',
    INPUT_OPERATION: 'apply',
    'INPUT_TARGET-KIND': 'pull-request',
    'INPUT_TARGET-NUMBERS': '12',
    INPUT_TRANSITION: 'start',
  });

  assert.equal(inputs.allowEmpty, true);
  assert.equal(inputs.configSource, 'workspace');
  assert.equal(inputs.dryRun, true);
  assert.equal(inputs.targetKind, 'pull-request');
  assert.deepEqual(inputs.targetNumbers, [12]);
});

test('semantic IDs are independent from visible label names', () => {
  const loaded = labeler.parseConfig(config());
  const transition = labeler.resolveTransition(loaded, 'start', false);
  assert.deepEqual(transition, {
    add: ['Currently building'],
    id: 'start',
    remove: ['Shipped anywhere', 'Queue for publication'],
  });
});

test('pattern removal is semantic and requires explicit opt-in', () => {
  const loaded = labeler.parseConfig(config());
  assert.throws(() => labeler.resolveTransition(loaded, 'finish', false), /allow-pattern-removal is false/);
  const transition = labeler.resolveTransition(loaded, 'finish', true);
  assert.deepEqual(transition.remove.sort(), ['Currently building', 'Queue for publication']);
});

test('label-change rules cannot mutate their own trigger label', () => {
  const invalid = config({
    events: {
      labelChanged: [{
        action: 'labeled',
        label: 'in_progress',
        targets: ['issue'],
        transition: 'start',
      }],
    },
  });
  assert.throws(() => labeler.parseConfig(invalid), /must not add or remove its trigger label/);
});

test('comment guards reference semantic label IDs', () => {
  const loaded = labeler.parseConfig(config());
  assert.deepEqual(loaded.events.get('issueCommented').requireLabels, ['waiting_for_release']);
  const invalid = config({
    events: {
      issueCommented: {
        transition: 'start',
        allowedActors: ['issue-author'],
        requireLabels: ['missing'],
      },
    },
  });
  assert.throws(() => labeler.parseConfig(invalid), /unknown required label ID "missing"/);
});

test('release selector implements all, any, and not', () => {
  const loaded = labeler.parseConfig(config());
  const selector = loaded.events.get('releasePublished').selector;
  const names = {
    all: selector.all.map((id) => loaded.labels.get(id).name.toLowerCase()),
    any: selector.any.map((id) => loaded.labels.get(id).name.toLowerCase()),
    not: selector.not.map((id) => loaded.labels.get(id).name.toLowerCase()),
  };
  assert.equal(labeler.matchesSelector({ labels: ['Queue for publication', 'Defect from users'] }, names), true);
  assert.equal(labeler.matchesSelector({ labels: ['Queue for publication'] }, names), false);
  assert.equal(labeler.matchesSelector({
    labels: ['Queue for publication', 'Currently building', 'Shipped anywhere'],
  }, names), false);
});

test('sync plans rename in place and keep unmanaged labels by default', () => {
  const loaded = labeler.parseConfig(config());
  const changes = labeler.planLabelSync(loaded, [
    { color: 'd73a4a', description: 'Something is not working.', name: 'bug' },
    { color: '123456', description: 'Owner label.', name: 'owner:ziqq' },
  ], { allowLabelDeletion: false });
  assert.equal(changes.find((change) => change.after?.id === 'bug').action, 'rename');
  assert.equal(changes.some((change) => change.before?.name === 'owner:ziqq'), false);
});

test('destructive orphan sync needs both config and action opt-in', () => {
  const loaded = labeler.parseConfig(config({
    sync: { excludeNamePatterns: [], managedNamePatterns: ['legacy:*'], orphanPolicy: 'delete' },
  }));
  const existing = [{ color: 'ffffff', description: '', name: 'legacy:old' }];
  assert.throws(
    () => labeler.planLabelSync(loaded, existing, { allowLabelDeletion: false }),
    /allow-label-deletion=true/,
  );
  const changes = labeler.planLabelSync(loaded, existing, { allowLabelDeletion: true });
  assert.equal(changes.some((change) => change.action === 'delete'), true);
});

test('target plans preserve unrelated labels', () => {
  const plan = labeler.targetPlan({
    kind: 'issue',
    labels: ['owner:ziqq', 'Currently building'],
    nodeId: 'I_1',
    number: 7,
  }, {
    add: ['Shipped anywhere'],
    remove: ['Currently building'],
  });
  assert.deepEqual(plan.final.sort(), ['Shipped anywhere', 'owner:ziqq']);
});

test('bulk guard rejects excess targets and empty selections', () => {
  assert.throws(
    () => labeler.enforceTargetCount([{ kind: 'issue', number: 1 }, { kind: 'issue', number: 2 }], {
      allowEmpty: false,
      maxTargets: 1,
    }),
    /exceeding max-targets/,
  );
  assert.throws(
    () => labeler.enforceTargetCount([], { allowEmpty: false, maxTargets: 10 }),
    /selected no targets/,
  );
});

test('trusted config defaults to PR base SHA then default branch', () => {
  assert.equal(labeler.trustedConfigRef({
    payload: { pull_request: { base: { sha: 'base-sha' } }, repository: { default_branch: 'main' } },
  }, ''), 'base-sha');
  assert.equal(labeler.trustedConfigRef({
    payload: { repository: { default_branch: 'main' } },
  }, ''), 'main');
});

test('issue references are parsed without duplicates', () => {
  const loaded = labeler.parseConfig(config());
  assert.equal(labeler.branchIssueNumber(loaded.config, 'ziqq/github-42/feature'), 42);
  assert.deepEqual(labeler.closingIssueNumbers(loaded.config, 'Fixes #2 and closes #2; fixed #3'), [2, 3]);
  assert.deepEqual(labeler.parseTargetNumbers('3, 2,3'), [3, 2]);
});
