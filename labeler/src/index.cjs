import fs from 'node:fs';
import path from 'node:path';

import * as core from '@actions/core';
import * as githubModule from '@actions/github';
import { Minimatch, minimatch } from 'minimatch';

const MAX_CONFIG_BYTES = 128 * 1024;
const OPERATIONS = new Set([
  'apply',
  'branch-created',
  'comment-event',
  'label-event',
  'path-labels',
  'pull-request',
  'release-published',
  'sync-labels',
]);
const TARGET_KINDS = new Set(['discussion', 'issue', 'pull-request']);
const EVENT_NAMES = new Set([
  'branchCreated',
  'discussionCommented',
  'issueCommented',
  'labelChanged',
  'pullRequestMerged',
  'pullRequestOpened',
  'releasePublished',
]);

class ConfigurationError extends Error {}

function fail(message) {
  throw new ConfigurationError(`Invalid label configuration: ${message}`);
}

function inputName(name) {
  return `INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
}

function getInput(env, name, fallback = '') {
  const value = env[inputName(name)];
  return value === undefined || value === '' ? fallback : value;
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`input "${name}" must be true or false.`);
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) fail(`input "${name}" must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail(`input "${name}" must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function parseChoice(value, name, choices) {
  if (!choices.includes(value)) fail(`input "${name}" must be one of: ${choices.join(', ')}.`);
  return value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, name) {
  if (!isObject(value)) fail(`"${name}" must be an object.`);
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) fail(`"${name}" must be a non-empty string.`);
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') fail(`"${name}" must be a boolean.`);
  return value;
}

function requireStringArray(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`"${name}" must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) fail(`"${name}" must not contain duplicates.`);
  return value;
}

function validateUnknownKeys(value, name, allowed) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`"${name}" contains unsupported property "${unknown}".`);
}

function compilePattern(value, name, flags) {
  requireString(value, name);
  try {
    return new RegExp(value, flags);
  } catch (error) {
    fail(`"${name}" is not a valid regular expression: ${error.message}`);
  }
}

function validateGlob(value, name) {
  try {
    return new Minimatch(value);
  } catch (error) {
    fail(`"${name}" is not a valid glob: ${error.message}`);
  }
}

function validateTransition(rawTransition, id, labels) {
  const transition = requireObject(rawTransition, `transitions.${id}`);
  const add = requireStringArray(transition.add, `transitions.${id}.add`, []);
  const remove = requireStringArray(transition.remove, `transitions.${id}.remove`, []);
  const removeIdPatterns = requireStringArray(
    transition.removeIdPatterns,
    `transitions.${id}.removeIdPatterns`,
    [],
  );
  if (add.length === 0 && remove.length === 0 && removeIdPatterns.length === 0) {
    fail(`transition "${id}" must add or remove at least one label.`);
  }
  for (const labelId of [...add, ...remove]) {
    if (!labels.has(labelId)) fail(`transition "${id}" references unknown label ID "${labelId}".`);
  }
  for (const [index, pattern] of removeIdPatterns.entries()) {
    validateGlob(pattern, `transitions.${id}.removeIdPatterns[${index}]`);
  }
  const conflict = add.find((labelId) => remove.includes(labelId));
  if (conflict) fail(`transition "${id}" both adds and removes label ID "${conflict}".`);
  validateUnknownKeys(transition, `transitions.${id}`, ['add', 'remove', 'removeIdPatterns']);
  return { add, remove, removeIdPatterns };
}

function validateReleaseSelector(rawSelector, name, labels) {
  const selector = requireObject(rawSelector, name);
  const all = requireStringArray(selector.all, `${name}.all`, []);
  const any = requireStringArray(selector.any, `${name}.any`, []);
  const not = requireStringArray(selector.not, `${name}.not`, []);
  if (all.length === 0 && any.length === 0 && not.length === 0) {
    fail(`"${name}" must contain at least one semantic label selector.`);
  }
  for (const labelId of [...all, ...any, ...not]) {
    if (!labels.has(labelId)) fail(`"${name}" references unknown label ID "${labelId}".`);
  }
  const state = selector.state ?? 'all';
  if (!['all', 'closed', 'open'].includes(state)) fail(`"${name}.state" must be all, closed, or open.`);
  validateUnknownKeys(selector, name, ['all', 'any', 'not', 'state']);
  return { all, any, not, state };
}

function validateCommentEvent(rawEvent, name, transitions, labels) {
  const event = requireObject(rawEvent, `events.${name}`);
  requireString(event.transition, `events.${name}.transition`);
  if (!transitions.has(event.transition)) fail(`event "${name}" references unknown transition.`);
  const allowedActors = requireStringArray(event.allowedActors, `events.${name}.allowedActors`);
  const requireLabels = requireStringArray(event.requireLabels, `events.${name}.requireLabels`, []);
  for (const labelId of requireLabels) {
    if (!labels.has(labelId)) fail(`event "${name}" references unknown required label ID "${labelId}".`);
  }
  const validActors = name === 'discussionCommented'
    ? new Set(['discussion-author'])
    : new Set(['assignee', 'issue-author']);
  for (const actor of allowedActors) {
    if (!validActors.has(actor)) fail(`event "${name}" contains unsupported actor "${actor}".`);
  }
  validateUnknownKeys(event, `events.${name}`, ['allowedActors', 'requireLabels', 'transition']);
  return { ...event, allowedActors, requireLabels };
}

function validateLabelEvents(rawEvents, transitions, labels) {
  if (!Array.isArray(rawEvents)) fail('"events.labelChanged" must be an array.');
  return rawEvents.map((rawEvent, index) => {
    const name = `events.labelChanged[${index}]`;
    const event = requireObject(rawEvent, name);
    if (!['labeled', 'unlabeled'].includes(event.action)) fail(`"${name}.action" must be labeled or unlabeled.`);
    requireString(event.label, `${name}.label`);
    if (!labels.has(event.label)) fail(`"${name}.label" references an unknown label ID.`);
    requireString(event.transition, `${name}.transition`);
    if (!transitions.has(event.transition)) fail(`"${name}.transition" references an unknown transition.`);
    const transition = transitions.get(event.transition);
    const changesTrigger = transition.add.includes(event.label)
      || transition.remove.includes(event.label)
      || transition.removeIdPatterns.some((pattern) => minimatch(event.label, pattern));
    if (changesTrigger) {
      fail(`"${name}" transition must not add or remove its trigger label; this can create event loops.`);
    }
    const targets = requireStringArray(event.targets, `${name}.targets`);
    for (const target of targets) {
      if (!TARGET_KINDS.has(target)) fail(`"${name}.targets" contains unsupported target "${target}".`);
    }
    validateUnknownKeys(event, name, ['action', 'label', 'targets', 'transition']);
    return { ...event, targets };
  });
}

function validateEvents(rawEvents, transitions, labels) {
  const source = requireObject(rawEvents ?? {}, 'events');
  const events = new Map();
  for (const [name, rawEvent] of Object.entries(source)) {
    if (!EVENT_NAMES.has(name)) fail(`unsupported event mapping "${name}".`);
    if (name === 'labelChanged') {
      events.set(name, validateLabelEvents(rawEvent, transitions, labels));
      continue;
    }
    if (name === 'issueCommented' || name === 'discussionCommented') {
      events.set(name, validateCommentEvent(rawEvent, name, transitions, labels));
      continue;
    }
    const event = requireObject(rawEvent, `events.${name}`);
    requireString(event.transition, `events.${name}.transition`);
    if (!transitions.has(event.transition)) fail(`event "${name}" references unknown transition.`);
    const allowed = ['transition'];
    if (name === 'branchCreated') {
      allowed.push('linkBranch');
      if (event.linkBranch !== undefined) requireBoolean(event.linkBranch, `events.${name}.linkBranch`);
    }
    if (name === 'pullRequestMerged' || name === 'pullRequestOpened') {
      allowed.push('baseBranches');
      if (event.baseBranches !== undefined) {
        requireStringArray(event.baseBranches, `events.${name}.baseBranches`);
      }
    }
    if (name === 'releasePublished') {
      allowed.push('selector');
      event.selector = validateReleaseSelector(event.selector, `events.${name}.selector`, labels);
    }
    validateUnknownKeys(event, `events.${name}`, allowed);
    events.set(name, event);
  }
  return events;
}

function validateSync(rawSync) {
  const sync = requireObject(rawSync ?? {}, 'sync');
  const orphanPolicy = sync.orphanPolicy ?? 'keep';
  if (!['delete', 'fail', 'keep'].includes(orphanPolicy)) {
    fail('"sync.orphanPolicy" must be delete, fail, or keep.');
  }
  const managedNamePatterns = requireStringArray(sync.managedNamePatterns, 'sync.managedNamePatterns', []);
  const excludeNamePatterns = requireStringArray(sync.excludeNamePatterns, 'sync.excludeNamePatterns', []);
  for (const [name, patterns] of Object.entries({ managedNamePatterns, excludeNamePatterns })) {
    patterns.forEach((pattern, index) => validateGlob(pattern, `sync.${name}[${index}]`));
  }
  if (orphanPolicy !== 'keep' && managedNamePatterns.length === 0) {
    fail('"sync.managedNamePatterns" is required when orphanPolicy is fail or delete.');
  }
  validateUnknownKeys(sync, 'sync', ['excludeNamePatterns', 'managedNamePatterns', 'orphanPolicy']);
  return { excludeNamePatterns, managedNamePatterns, orphanPolicy };
}

function parseConfig(source) {
  let config;
  try {
    config = typeof source === 'string' ? JSON.parse(source) : source;
  } catch (error) {
    fail(`configuration is not valid JSON: ${error.message}`);
  }
  requireObject(config, 'root');
  if (config.schema !== 4) fail('"schema" must equal 4.');

  const rawLabels = requireObject(config.labels, 'labels');
  if (Object.keys(rawLabels).length === 0) fail('"labels" must not be empty.');
  const labels = new Map();
  const names = new Map();
  const previousNames = new Set();
  for (const [id, rawLabel] of Object.entries(rawLabels)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) fail(`label ID "${id}" must use lower_snake_case.`);
    const label = requireObject(rawLabel, `labels.${id}`);
    const name = requireString(label.name, `labels.${id}.name`);
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) fail(`labels "${id}" and "${names.get(normalizedName)}" share a name.`);
    names.set(normalizedName, id);
    if (typeof label.color !== 'string' || !/^[0-9a-f]{6}$/i.test(label.color)) {
      fail(`"labels.${id}.color" must contain six hexadecimal characters.`);
    }
    if (typeof label.description !== 'string' || label.description.length > 100) {
      fail(`"labels.${id}.description" must be a string with at most 100 characters.`);
    }
    const prior = requireStringArray(label.previousNames, `labels.${id}.previousNames`, []);
    for (const previousName of prior) {
      const normalized = previousName.toLowerCase();
      if (normalized === normalizedName) fail(`label "${id}" repeats its current name in previousNames.`);
      if (previousNames.has(normalized)) fail(`previous label name "${previousName}" is declared more than once.`);
      previousNames.add(normalized);
    }
    const paths = requireStringArray(label.paths, `labels.${id}.paths`, []);
    paths.forEach((glob, index) => validateGlob(glob, `labels.${id}.paths[${index}]`));
    validateUnknownKeys(label, `labels.${id}`, ['color', 'description', 'name', 'paths', 'previousNames']);
    labels.set(id, { color: label.color.toLowerCase(), description: label.description, id, name, paths, previousNames: prior });
  }
  for (const previousName of previousNames) {
    if (names.has(previousName)) fail(`previous label name "${previousName}" is also a current label name.`);
  }

  const references = requireObject(config.references ?? {}, 'references');
  const branchIssuePattern = references.branchIssuePattern ?? 'github-(\\d+)';
  const closingIssuePattern = references.closingIssuePattern
    ?? '(?:close[sd]?|fixe[sd]?|resolve[sd]?)\\s+#(\\d+)';
  compilePattern(branchIssuePattern, 'references.branchIssuePattern', 'i');
  compilePattern(closingIssuePattern, 'references.closingIssuePattern', 'gi');
  validateUnknownKeys(references, 'references', ['branchIssuePattern', 'closingIssuePattern']);

  const rawTransitions = requireObject(config.transitions, 'transitions');
  if (Object.keys(rawTransitions).length === 0) fail('"transitions" must not be empty.');
  const transitions = new Map();
  for (const [id, transition] of Object.entries(rawTransitions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) fail(`transition ID "${id}" must use lower_snake_case.`);
    transitions.set(id, validateTransition(transition, id, labels));
  }

  const events = validateEvents(config.events, transitions, labels);
  const sync = validateSync(config.sync);
  validateUnknownKeys(config, 'root', ['events', 'labels', 'references', 'schema', 'sync', 'transitions']);
  return {
    config: {
      ...config,
      references: { branchIssuePattern, closingIssuePattern },
    },
    events,
    labels,
    sync,
    transitions,
  };
}

function resolveWorkspaceConfigPath(configPath, workspace) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, configPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('input "config-path" must resolve inside the caller workspace.');
  }
  return resolved;
}

function trustedConfigRef(context, explicitRef) {
  if (explicitRef) return explicitRef;
  const baseSha = context.payload.pull_request?.base?.sha;
  if (baseSha) return baseSha;
  const defaultBranch = context.payload.repository?.default_branch;
  if (defaultBranch) return defaultBranch;
  fail('cannot determine a trusted config ref; set config-ref explicitly.');
}

async function loadConfig({ client, context, configPath, configRef, configSource, workspace }) {
  let source;
  let sourceDescription;
  if (configSource === 'workspace') {
    const resolved = resolveWorkspaceConfigPath(configPath, workspace);
    let stat;
    try {
      stat = fs.statSync(resolved);
      source = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      fail(`cannot read workspace config "${resolved}": ${error.message}`);
    }
    if (!stat.isFile()) fail('workspace config must be a regular file.');
    if (stat.size > MAX_CONFIG_BYTES) fail(`workspace config exceeds ${MAX_CONFIG_BYTES} bytes.`);
    sourceDescription = resolved;
  } else {
    const ref = trustedConfigRef(context, configRef);
    const { data } = await client.rest.repos.getContent({
      owner: context.repo.owner,
      path: configPath,
      ref,
      repo: context.repo.repo,
    });
    if (Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64') {
      fail(`API config "${configPath}" at "${ref}" must be a base64-encoded file.`);
    }
    const bytes = Buffer.from(data.content.replaceAll('\n', ''), 'base64');
    if (bytes.length > MAX_CONFIG_BYTES) fail(`API config exceeds ${MAX_CONFIG_BYTES} bytes.`);
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sourceDescription = `${configPath}@${ref}`;
  }
  const loaded = parseConfig(source);
  return { ...loaded, sourceDescription };
}

function parseTargetNumbers(value) {
  if (!value) return [];
  const numbers = [];
  for (const item of String(value).split(',')) {
    const normalized = item.trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
      fail(`invalid target number "${normalized}".`);
    }
    const number = Number(normalized);
    if (!numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function buildInputs(env = process.env) {
  const operation = getInput(env, 'operation');
  if (!OPERATIONS.has(operation)) fail(`unsupported operation "${operation}".`);
  const targetKind = parseChoice(getInput(env, 'target-kind', 'issue'), 'target-kind', [...TARGET_KINDS]);
  const configSource = parseChoice(getInput(env, 'config-source', 'api'), 'config-source', ['api', 'workspace']);
  const inputs = {
    allowEmpty: parseBoolean(getInput(env, 'allow-empty', 'false'), 'allow-empty'),
    allowLabelDeletion: parseBoolean(
      getInput(env, 'allow-label-deletion', 'false'),
      'allow-label-deletion',
    ),
    allowPatternRemoval: parseBoolean(
      getInput(env, 'allow-pattern-removal', 'false'),
      'allow-pattern-removal',
    ),
    configPath: getInput(env, 'config-path', '.github/labels.json'),
    configRef: getInput(env, 'config-ref'),
    configSource,
    dryRun: parseBoolean(getInput(env, 'dry-run', 'false'), 'dry-run'),
    maxFiles: parseInteger(getInput(env, 'max-files', '3000'), 'max-files', 1, 100_000),
    maxTargets: parseInteger(getInput(env, 'max-targets', '100'), 'max-targets', 1, 10_000),
    operation,
    targetKind,
    targetNumbers: parseTargetNumbers(getInput(env, 'target-numbers')),
    transition: getInput(env, 'transition'),
  };
  if (operation === 'apply') {
    if (!inputs.transition) fail('apply requires input "transition".');
    if (inputs.targetNumbers.length === 0 && !inputs.allowEmpty) {
      fail('apply requires target-numbers unless allow-empty is true.');
    }
  }
  return inputs;
}

function branchIssueNumber(config, text) {
  const match = String(text ?? '').match(new RegExp(config.references.branchIssuePattern, 'i'));
  const number = match?.[1] ? Number(match[1]) : null;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function closingIssueNumbers(config, text) {
  const pattern = new RegExp(config.references.closingIssuePattern, 'gi');
  const numbers = [];
  for (const match of String(text ?? '').matchAll(pattern)) {
    const number = match[1] ? Number(match[1]) : null;
    if (Number.isSafeInteger(number) && number > 0 && !numbers.includes(number)) numbers.push(number);
  }
  return numbers;
}

function resolveTransition(loaded, id, allowPatternRemoval) {
  const transition = loaded.transitions.get(id);
  if (!transition) fail(`unknown transition "${id}".`);
  if (transition.removeIdPatterns.length > 0 && !allowPatternRemoval) {
    fail(`transition "${id}" uses removeIdPatterns but allow-pattern-removal is false.`);
  }
  const removeIds = new Set(transition.remove);
  for (const pattern of transition.removeIdPatterns) {
    const matches = [...loaded.labels.keys()].filter((labelId) => minimatch(labelId, pattern));
    if (matches.length === 0) fail(`transition "${id}" pattern "${pattern}" matches no semantic label IDs.`);
    matches.forEach((labelId) => removeIds.add(labelId));
  }
  for (const labelId of transition.add) removeIds.delete(labelId);
  return {
    add: transition.add.map((labelId) => loaded.labels.get(labelId).name),
    id,
    remove: [...removeIds].map((labelId) => loaded.labels.get(labelId).name),
  };
}

function createResult(inputs, loaded) {
  return {
    added: [],
    config: loaded.sourceDescription,
    dryRun: inputs.dryRun,
    operation: inputs.operation,
    partialFailures: [],
    removed: [],
    skipped: [],
    targets: [],
    transition: '',
    warnings: [],
  };
}

function setOutputs(result) {
  core.setOutput('plan', JSON.stringify(result));
  core.setOutput('transition', result.transition);
  core.setOutput('targets', JSON.stringify(result.targets));
  core.setOutput('added', JSON.stringify(result.added));
  core.setOutput('removed', JSON.stringify(result.removed));
  core.setOutput('skipped', JSON.stringify(result.skipped));
  core.setOutput('warnings', JSON.stringify(result.warnings));
  core.setOutput('partial-failures', JSON.stringify(result.partialFailures));
}

async function repositoryLabels(client, context) {
  return client.paginate(client.rest.issues.listLabelsForRepo, {
    owner: context.repo.owner,
    per_page: 100,
    repo: context.repo.repo,
  });
}

function labelsByName(labels) {
  return new Map(labels.map((label) => [label.name.toLowerCase(), label]));
}

function ensureTransitionLabelsExist(transition, existing) {
  const missing = [...transition.add, ...transition.remove]
    .filter((name) => !existing.has(name.toLowerCase()));
  if (missing.length > 0) {
    fail(`repository labels are not synchronized; missing: ${[...new Set(missing)].join(', ')}.`);
  }
}

function isManagedOrphan(name, loaded, configuredNames) {
  if (configuredNames.has(name.toLowerCase())) return false;
  if (!loaded.sync.managedNamePatterns.some((pattern) => minimatch(name, pattern, { nocase: true }))) return false;
  return !loaded.sync.excludeNamePatterns.some((pattern) => minimatch(name, pattern, { nocase: true }));
}

function planLabelSync(loaded, existing, inputs) {
  const byName = labelsByName(existing);
  const changes = [];
  const configuredNames = new Set();
  for (const label of loaded.labels.values()) {
    configuredNames.add(label.name.toLowerCase());
    label.previousNames.forEach((name) => configuredNames.add(name.toLowerCase()));
    let current = byName.get(label.name.toLowerCase());
    if (!current) {
      current = label.previousNames.map((name) => byName.get(name.toLowerCase())).find(Boolean);
    }
    if (!current) {
      changes.push({ action: 'create', after: label, semanticId: label.id });
      continue;
    }
    const metadataMatches = current.name === label.name
      && current.color.toLowerCase() === label.color
      && (current.description ?? '') === label.description;
    if (metadataMatches) {
      changes.push({ action: 'skip', name: label.name, semanticId: label.id });
    } else {
      changes.push({ action: current.name === label.name ? 'update' : 'rename', after: label, before: current });
    }
  }
  const orphans = existing.filter((label) => isManagedOrphan(label.name, loaded, configuredNames));
  if (orphans.length > 0 && loaded.sync.orphanPolicy === 'fail') {
    fail(`managed orphan labels exist: ${orphans.map((label) => label.name).join(', ')}.`);
  }
  if (orphans.length > 0 && loaded.sync.orphanPolicy === 'delete') {
    if (!inputs.allowLabelDeletion) {
      fail('orphanPolicy=delete requires allow-label-deletion=true.');
    }
    orphans.forEach((label) => changes.push({ action: 'delete', before: label }));
  }
  return changes;
}

async function applyLabelSync({ client, context, inputs, loaded, result }) {
  const existing = await repositoryLabels(client, context);
  const changes = planLabelSync(loaded, existing, inputs);
  result.labelChanges = changes.map((change) => ({
    action: change.action,
    from: change.before?.name ?? '',
    semanticId: change.semanticId ?? change.after?.id ?? '',
    to: change.after?.name ?? change.name ?? '',
  }));
  for (const change of changes) {
    if (change.action === 'skip') {
      result.skipped.push({ kind: 'label', name: change.name, reason: 'already-synchronized' });
      continue;
    }
    if (inputs.dryRun) continue;
    try {
      if (change.action === 'create') {
        await client.rest.issues.createLabel({
          color: change.after.color,
          description: change.after.description,
          name: change.after.name,
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
        result.added.push({ kind: 'repository-label', name: change.after.name });
      } else if (change.action === 'delete') {
        await client.rest.issues.deleteLabel({
          name: change.before.name,
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
        result.removed.push({ kind: 'repository-label', name: change.before.name });
      } else {
        await client.rest.issues.updateLabel({
          color: change.after.color,
          description: change.after.description,
          name: change.before.name,
          ...(change.action === 'rename' ? { new_name: change.after.name } : {}),
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
        if (change.action === 'rename') {
          result.removed.push({ kind: 'repository-label', name: change.before.name });
          result.added.push({ kind: 'repository-label', name: change.after.name });
        }
      }
    } catch (error) {
      if (result.added.length > 0 || result.removed.length > 0) {
        result.partialFailures.push({
          action: change.action,
          kind: 'repository-label',
          name: change.after?.name ?? change.before?.name,
          reason: error.message,
        });
      }
      throw error;
    }
  }
}

function normalizeLabelNames(labels) {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter(Boolean);
}

async function fetchIssueTarget(client, context, number, expectedKind) {
  const { data } = await client.rest.issues.get({
    issue_number: number,
    owner: context.repo.owner,
    repo: context.repo.repo,
  });
  const actualKind = data.pull_request ? 'pull-request' : 'issue';
  if (expectedKind !== actualKind) {
    fail(`target #${number} is ${actualKind}, not ${expectedKind}.`);
  }
  return {
    kind: actualKind,
    labels: normalizeLabelNames(data.labels),
    nodeId: data.node_id,
    number,
  };
}

async function fetchDiscussionTarget(client, context, number) {
  const data = await client.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
       repository(owner: $owner, name: $repo) {
         discussion(number: $number) {
           id
           number
           labels(first: 100) { nodes { id name } }
         }
       }
     }`,
    { number, owner: context.repo.owner, repo: context.repo.repo },
  );
  const discussion = data.repository?.discussion;
  if (!discussion) fail(`discussion #${number} does not exist.`);
  return {
    kind: 'discussion',
    labelNodes: discussion.labels.nodes,
    labels: discussion.labels.nodes.map((label) => label.name),
    nodeId: discussion.id,
    number,
  };
}

async function fetchTargets(client, context, descriptors) {
  const targets = [];
  for (const descriptor of descriptors) {
    targets.push(descriptor.kind === 'discussion'
      ? await fetchDiscussionTarget(client, context, descriptor.number)
      : await fetchIssueTarget(client, context, descriptor.number, descriptor.kind));
  }
  return targets;
}

function enforceTargetCount(descriptors, inputs) {
  const unique = new Map();
  for (const target of descriptors) unique.set(`${target.kind}:${target.number}`, target);
  const result = [...unique.values()];
  if (result.length > inputs.maxTargets) {
    fail(`operation selected ${result.length} targets, exceeding max-targets=${inputs.maxTargets}.`);
  }
  if (result.length === 0 && !inputs.allowEmpty) {
    fail('operation selected no targets; set allow-empty=true only when this is expected.');
  }
  return result;
}

function targetPlan(target, transition) {
  const current = new Map(target.labels.map((name) => [name.toLowerCase(), name]));
  const add = transition.add.filter((name) => !current.has(name.toLowerCase()));
  const remove = transition.remove
    .map((name) => current.get(name.toLowerCase()))
    .filter(Boolean);
  const final = target.labels.filter(
    (name) => !remove.some((removed) => removed.toLowerCase() === name.toLowerCase()),
  );
  for (const name of add) {
    if (!final.some((currentName) => currentName.toLowerCase() === name.toLowerCase())) final.push(name);
  }
  return {
    add,
    final,
    kind: target.kind,
    nodeId: target.nodeId,
    number: target.number,
    remove,
  };
}

async function mutateDiscussion(client, plan, repoLabels) {
  let changed = false;
  if (plan.add.length > 0) {
    await client.graphql(
      `mutation($labelableId: ID!, $labelIds: [ID!]!) {
         addLabelsToLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId }
       }`,
      {
        labelableId: plan.nodeId,
        labelIds: plan.add.map((name) => repoLabels.get(name.toLowerCase()).node_id),
      },
    );
    changed = true;
  }
  if (plan.remove.length > 0) {
    try {
      await client.graphql(
        `mutation($labelableId: ID!, $labelIds: [ID!]!) {
           removeLabelsFromLabelable(input: {labelableId: $labelableId, labelIds: $labelIds}) { clientMutationId }
         }`,
        {
          labelableId: plan.nodeId,
          labelIds: plan.remove.map((name) => repoLabels.get(name.toLowerCase()).node_id),
        },
      );
    } catch (error) {
      error.partial = changed;
      throw error;
    }
  }
}

async function applyPlans({ client, context, inputs, plans, repoLabels, result }) {
  result.targets = plans.map(({ add, kind, number, remove }) => ({ add, kind, number, remove }));
  let completed = 0;
  for (const plan of plans) {
    if (plan.add.length === 0 && plan.remove.length === 0) {
      result.skipped.push({ kind: plan.kind, number: plan.number, reason: 'already-in-target-state' });
      continue;
    }
    if (inputs.dryRun) continue;
    try {
      if (plan.kind === 'discussion') {
        await mutateDiscussion(client, plan, repoLabels);
      } else {
        await client.rest.issues.setLabels({
          issue_number: plan.number,
          labels: plan.final,
          owner: context.repo.owner,
          repo: context.repo.repo,
        });
      }
      completed += 1;
      plan.add.forEach((name) => result.added.push({ kind: plan.kind, name, number: plan.number }));
      plan.remove.forEach((name) => result.removed.push({ kind: plan.kind, name, number: plan.number }));
    } catch (error) {
      if (completed > 0 || error.partial === true) {
        result.partialFailures.push({ kind: plan.kind, number: plan.number, reason: error.message });
      }
      throw error;
    }
  }
}

async function applyTransitionToTargets({ client, context, descriptors, inputs, loaded, result, transitionId }) {
  const selected = enforceTargetCount(descriptors, inputs);
  const transition = resolveTransition(loaded, transitionId, inputs.allowPatternRemoval);
  result.transition = transition.id;
  const existingLabels = await repositoryLabels(client, context);
  const byName = labelsByName(existingLabels);
  ensureTransitionLabelsExist(transition, byName);
  const targets = await fetchTargets(client, context, selected);
  const plans = targets.map((target) => targetPlan(target, transition));
  await applyPlans({ client, context, inputs, plans, repoLabels: byName, result });
}

async function linkBranch({ client, context, inputs, issueNumber, ref, result }) {
  const { data: refData } = await client.rest.git.getRef({
    owner: context.repo.owner,
    ref: `heads/${ref}`,
    repo: context.repo.repo,
  });
  const { data: issue } = await client.rest.issues.get({
    issue_number: issueNumber,
    owner: context.repo.owner,
    repo: context.repo.repo,
  });
  if (inputs.dryRun) {
    result.branchLink = { issueNumber, ref, status: 'planned' };
    return;
  }
  try {
    await client.graphql(
      `mutation($issueId: ID!, $oid: GitObjectID!, $name: String!, $repositoryId: ID!) {
         createLinkedBranch(input: {
           issueId: $issueId,
           oid: $oid,
           name: $name,
           repositoryId: $repositoryId
         }) { linkedBranch { id } }
       }`,
      {
        issueId: issue.node_id,
        name: ref,
        oid: refData.object.sha,
        repositoryId: context.payload.repository.node_id,
      },
    );
    result.branchLink = { issueNumber, ref, status: 'linked' };
  } catch (error) {
    const warning = `createLinkedBranch failed for "${ref}": ${error.message}`;
    result.warnings.push(warning);
    core.warning(warning);
  }
}

async function handleBranchCreated(args) {
  const { client, context, inputs, loaded, result } = args;
  const event = loaded.events.get('branchCreated');
  if (!event || context.eventName !== 'create' || context.payload.ref_type !== 'branch') {
    result.skipped.push({ reason: 'branch-event-not-configured-or-not-applicable' });
    return;
  }
  const ref = context.payload.ref ?? '';
  const issueNumber = branchIssueNumber(loaded.config, ref);
  if (!issueNumber) {
    result.skipped.push({ reason: 'branch-has-no-issue-reference', ref });
    return;
  }
  await applyTransitionToTargets({
    ...args,
    descriptors: [{ kind: 'issue', number: issueNumber }],
    transitionId: event.transition,
  });
  if (event.linkBranch === true) {
    await linkBranch({ client, context, inputs, issueNumber, ref, result });
  }
}

function collectPullRequestIssueNumbers(context, config) {
  const pullRequest = context.payload.pull_request;
  const numbers = new Set();
  const branchNumber = branchIssueNumber(config, pullRequest?.head?.ref);
  if (branchNumber) numbers.add(branchNumber);
  for (const value of [pullRequest?.body, pullRequest?.title]) {
    closingIssueNumbers(config, value).forEach((number) => numbers.add(number));
  }
  return [...numbers];
}

async function handlePullRequest(args) {
  const { context, loaded, result } = args;
  if (!['pull_request', 'pull_request_target'].includes(context.eventName)) {
    result.skipped.push({ reason: 'not-a-pull-request-event' });
    return;
  }
  const pullRequest = context.payload.pull_request;
  let eventName;
  if (['opened', 'reopened', 'ready_for_review'].includes(context.payload.action)) {
    eventName = 'pullRequestOpened';
  } else if (context.payload.action === 'closed' && pullRequest?.merged === true) {
    eventName = 'pullRequestMerged';
  } else {
    result.skipped.push({ action: context.payload.action, reason: 'pull-request-action-has-no-transition' });
    return;
  }
  const event = loaded.events.get(eventName);
  if (!event) {
    result.skipped.push({ event: eventName, reason: 'event-not-configured' });
    return;
  }
  if (event.baseBranches?.length && !event.baseBranches.includes(pullRequest?.base?.ref)) {
    result.skipped.push({ event: eventName, reason: 'base-branch-not-configured' });
    return;
  }
  const descriptors = collectPullRequestIssueNumbers(context, loaded.config)
    .map((number) => ({ kind: 'issue', number }));
  await applyTransitionToTargets({ ...args, descriptors, transitionId: event.transition });
}

function selectorNames(selector, loaded) {
  return Object.fromEntries(['all', 'any', 'not'].map((operator) => [
    operator,
    selector[operator].map((labelId) => loaded.labels.get(labelId).name.toLowerCase()),
  ]));
}

function matchesSelector(issue, names) {
  const current = new Set(normalizeLabelNames(issue.labels).map((name) => name.toLowerCase()));
  return names.all.every((name) => current.has(name))
    && (names.any.length === 0 || names.any.some((name) => current.has(name)))
    && names.not.every((name) => !current.has(name));
}

async function releaseTargets({ client, context, inputs, loaded, event }) {
  const names = selectorNames(event.selector, loaded);
  const descriptors = [];
  const iterator = client.paginate.iterator(client.rest.issues.listForRepo, {
    owner: context.repo.owner,
    per_page: 100,
    repo: context.repo.repo,
    state: event.selector.state,
  });
  for await (const response of iterator) {
    for (const issue of response.data) {
      if (!issue.pull_request && matchesSelector(issue, names)) {
        descriptors.push({ kind: 'issue', number: issue.number });
        if (descriptors.length > inputs.maxTargets) {
          fail(`release selector exceeds max-targets=${inputs.maxTargets}.`);
        }
      }
    }
  }
  return descriptors;
}

async function handleReleasePublished(args) {
  const { client, context, inputs, loaded, result } = args;
  const event = loaded.events.get('releasePublished');
  if (!event || context.eventName !== 'release' || context.payload.action !== 'published') {
    result.skipped.push({ reason: 'release-event-not-configured-or-not-applicable' });
    return;
  }
  const descriptors = await releaseTargets({ client, context, event, inputs, loaded });
  await applyTransitionToTargets({ ...args, descriptors, transitionId: event.transition });
}

function issueCommentAllowed(context, event) {
  const issue = context.payload.issue;
  const login = context.payload.comment?.user?.login;
  const actors = new Set(event.allowedActors);
  return (actors.has('issue-author') && login === issue?.user?.login)
    || (actors.has('assignee') && issue?.assignees?.some((assignee) => assignee.login === login));
}

function discussionCommentAllowed(context, event) {
  const discussion = context.payload.discussion;
  const login = context.payload.comment?.user?.login ?? context.payload.comment?.author?.login;
  const author = discussion?.user?.login ?? discussion?.author?.login;
  return event.allowedActors.includes('discussion-author') && login === author;
}

async function commentTargetHasRequiredLabels(client, context, event, loaded, descriptor) {
  if (event.requireLabels.length === 0) return true;
  const target = descriptor.kind === 'discussion'
    ? await fetchDiscussionTarget(client, context, descriptor.number)
    : await fetchIssueTarget(client, context, descriptor.number, descriptor.kind);
  const current = new Set(target.labels.map((name) => name.toLowerCase()));
  return event.requireLabels.every((labelId) => current.has(loaded.labels.get(labelId).name.toLowerCase()));
}

async function handleCommentEvent(args) {
  const { client, context, loaded, result } = args;
  if (context.payload.action !== 'created') {
    result.skipped.push({ reason: 'comment-action-not-created' });
    return;
  }
  if (context.eventName === 'issue_comment') {
    const issue = context.payload.issue;
    if (issue?.pull_request) {
      result.skipped.push({ reason: 'pull-request-comments-are-not-issue-comments' });
      return;
    }
    const event = loaded.events.get('issueCommented');
    if (!event || !issueCommentAllowed(context, event)) {
      result.skipped.push({ reason: 'issue-comment-not-configured-or-actor-not-allowed' });
      return;
    }
    const descriptor = { kind: 'issue', number: issue.number };
    if (!await commentTargetHasRequiredLabels(client, context, event, loaded, descriptor)) {
      result.skipped.push({ reason: 'issue-comment-required-labels-not-present' });
      return;
    }
    await applyTransitionToTargets({
      ...args,
      descriptors: [descriptor],
      transitionId: event.transition,
    });
    return;
  }
  if (context.eventName === 'discussion_comment') {
    const event = loaded.events.get('discussionCommented');
    if (!event || !discussionCommentAllowed(context, event)) {
      result.skipped.push({ reason: 'discussion-comment-not-configured-or-actor-not-allowed' });
      return;
    }
    const descriptor = { kind: 'discussion', number: context.payload.discussion.number };
    if (!await commentTargetHasRequiredLabels(client, context, event, loaded, descriptor)) {
      result.skipped.push({ reason: 'discussion-comment-required-labels-not-present' });
      return;
    }
    await applyTransitionToTargets({
      ...args,
      descriptors: [descriptor],
      transitionId: event.transition,
    });
    return;
  }
  result.skipped.push({ reason: 'unsupported-comment-event' });
}

function labelEventTarget(context) {
  if (context.eventName === 'issues') return { kind: 'issue', number: context.payload.issue.number };
  if (['pull_request', 'pull_request_target'].includes(context.eventName)) {
    return { kind: 'pull-request', number: context.payload.pull_request.number };
  }
  if (context.eventName === 'discussion') {
    return { kind: 'discussion', number: context.payload.discussion.number };
  }
  return null;
}

async function handleLabelEvent(args) {
  const { context, loaded, result } = args;
  const target = labelEventTarget(context);
  const labelName = context.payload.label?.name;
  if (!target || !labelName || !['labeled', 'unlabeled'].includes(context.payload.action)) {
    result.skipped.push({ reason: 'unsupported-label-event' });
    return;
  }
  const semantic = [...loaded.labels.values()]
    .find((label) => label.name.toLowerCase() === labelName.toLowerCase());
  if (!semantic) {
    result.skipped.push({ label: labelName, reason: 'label-is-not-managed' });
    return;
  }
  const rule = (loaded.events.get('labelChanged') ?? []).find((event) => (
    event.action === context.payload.action
    && event.label === semantic.id
    && event.targets.includes(target.kind)
  ));
  if (!rule) {
    result.skipped.push({ label: semantic.id, reason: 'label-event-rule-not-configured' });
    return;
  }
  await applyTransitionToTargets({ ...args, descriptors: [target], transitionId: rule.transition });
}

async function changedFiles(client, context, inputs) {
  const number = context.payload.pull_request?.number;
  if (!number) fail('path-labels requires a pull request event payload.');
  const files = [];
  const iterator = client.paginate.iterator(client.rest.pulls.listFiles, {
    owner: context.repo.owner,
    per_page: 100,
    pull_number: number,
    repo: context.repo.repo,
  });
  for await (const response of iterator) {
    for (const file of response.data) {
      files.push(file.filename);
      if (files.length > inputs.maxFiles) fail(`pull request exceeds max-files=${inputs.maxFiles}.`);
    }
  }
  return files;
}

async function handlePathLabels(args) {
  const { client, context, inputs, loaded, result } = args;
  if (!['pull_request', 'pull_request_target'].includes(context.eventName)) {
    result.skipped.push({ reason: 'not-a-pull-request-event' });
    return;
  }
  const managed = [...loaded.labels.values()].filter((label) => label.paths.length > 0);
  if (managed.length === 0) fail('path-labels requires at least one label with paths.');
  const files = await changedFiles(client, context, inputs);
  const target = await fetchIssueTarget(client, context, context.payload.pull_request.number, 'pull-request');
  const add = [];
  const remove = [];
  const current = new Set(target.labels.map((name) => name.toLowerCase()));
  for (const label of managed) {
    const matches = files.some((file) => label.paths.some((glob) => minimatch(file, glob, { dot: true })));
    if (matches && !current.has(label.name.toLowerCase())) add.push(label.name);
    if (!matches && current.has(label.name.toLowerCase())) remove.push(label.name);
  }
  const repoLabels = labelsByName(await repositoryLabels(client, context));
  ensureTransitionLabelsExist({ add, remove }, repoLabels);
  result.transition = 'path-labels';
  await applyPlans({
    client,
    context,
    inputs,
    plans: [targetPlan(target, { add, remove })],
    repoLabels,
    result,
  });
}

async function execute({ client, context, inputs, loaded, result }) {
  const args = { client, context, inputs, loaded, result };
  switch (inputs.operation) {
    case 'sync-labels':
      await applyLabelSync(args);
      break;
    case 'path-labels':
      await handlePathLabels(args);
      break;
    case 'branch-created':
      await handleBranchCreated(args);
      break;
    case 'pull-request':
      await handlePullRequest(args);
      break;
    case 'release-published':
      await handleReleasePublished(args);
      break;
    case 'comment-event':
      await handleCommentEvent(args);
      break;
    case 'label-event':
      await handleLabelEvent(args);
      break;
    case 'apply':
      await applyTransitionToTargets({
        ...args,
        descriptors: inputs.targetNumbers.map((number) => ({ kind: inputs.targetKind, number })),
        transitionId: inputs.transition,
      });
      break;
    default:
      fail(`unsupported operation "${inputs.operation}".`);
  }
}

async function main(env = process.env, context = githubModule.context) {
  const token = getInput(env, 'github-token');
  if (!token) fail('input "github-token" is required.');
  core.setSecret(token);
  const inputs = buildInputs(env);
  const client = githubModule.getOctokit(token);
  const loaded = await loadConfig({
    client,
    configPath: inputs.configPath,
    configRef: inputs.configRef,
    configSource: inputs.configSource,
    context,
    workspace: env.GITHUB_WORKSPACE || process.cwd(),
  });
  const result = createResult(inputs, loaded);
  try {
    await execute({ client, context, inputs, loaded, result });
    setOutputs(result);
    core.info(inputs.dryRun ? 'Label plan validated; no mutations were made.' : 'Label operation completed.');
    return result;
  } catch (error) {
    setOutputs(result);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    core.setFailed(error instanceof ConfigurationError ? error.message : `Label operation failed: ${error.message}`);
  });
}

export {
  ConfigurationError,
  branchIssueNumber,
  buildInputs,
  closingIssueNumbers,
  enforceTargetCount,
  matchesSelector,
  parseConfig,
  parseTargetNumbers,
  planLabelSync,
  resolveTransition,
  targetPlan,
  trustedConfigRef,
};
