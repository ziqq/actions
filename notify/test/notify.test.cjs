const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const notify = require('../dist/index.js');

test('renders a safe template for Discord and Telegram', () => {
  const source = [
    '# Release {{version}}',
    '',
    '**Package:** {{package}}',
    '1. First',
    '2. Second',
    '{{#if changelog_url}}[Changelog]({{url changelog_url}}){{/if}}',
  ].join('\n');
  const values = {
    changelog_url: 'https://example.test/releases/1.0.0',
    package: 'name_*_<unsafe>',
    version: '1.0.0',
  };

  const discord = notify.renderTemplate(source, values, 'discord', 'release.md.tmpl');
  const telegram = notify.renderTemplate(source, values, 'telegram', 'release.md.tmpl');

  assert.match(discord, /name\\_\\\*\\_\\<unsafe\\>/);
  assert.match(discord, /\[Changelog\]\(https:\/\/example\.test\/releases\/1\.0\.0\)/);
  assert.match(telegram, /<b>Package:<\/b> name_\*_&lt;unsafe&gt;/);
  assert.match(telegram, /1\. First\n2\. Second/);
  assert.match(telegram, /<a href="https:\/\/example\.test\/releases\/1\.0\.0">Changelog<\/a>/);
});

test('validates variables even inside a false conditional', () => {
  assert.throws(
    () => notify.renderTemplate('{{#if missing}}x{{unknown}}{{/if}}', {}, 'discord'),
    /unknown template variable "missing"/,
  );
});

test('rejects unsafe or unsupported Markdown', () => {
  assert.throws(
    () => notify.renderTemplate('[unsafe]({{url target}})', { target: 'javascript:alert(1)' }, 'discord'),
    /must use HTTP or HTTPS/,
  );
  assert.throws(
    () => notify.renderTemplate('<details>hidden</details>', {}, 'telegram'),
    /unsupported Markdown construct "html_(?:inline|block)"/,
  );
  assert.throws(
    () => notify.renderTemplate('![image](https://example.test/image.png)', {}, 'telegram'),
    /unsupported Markdown construct "image"/,
  );
});

test('buildConfiguration keeps templates inside the workspace and needs no targets in validate mode', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
  fs.writeFileSync(path.join(workspace, 'message.md.tmpl'), 'Hello {{name}}\n');
  const config = notify.buildConfiguration({
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_WORKSPACE: workspace,
    INPUT_MODE: 'validate',
    INPUT_PROVIDERS: 'discord,telegram',
    INPUT_TEMPLATE_PATH: 'message.md.tmpl',
    INPUT_VARIABLES: '{"name":"world"}',
  });
  assert.deepEqual(config.providers, ['discord', 'telegram']);
  assert.equal(config.discord.webhooks.length, 0);
  assert.equal(config.telegram.targets.length, 0);
  assert.equal(config.values.github.ref_name, 'v1.2.3');

  assert.throws(() => notify.buildConfiguration({
    GITHUB_WORKSPACE: workspace,
    INPUT_MODE: 'validate',
    INPUT_PROVIDERS: 'discord',
    INPUT_TEMPLATE_PATH: '../outside.md.tmpl',
  }), /must resolve inside/);
});

test('Telegram targets use an explicit root object', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-targets-test-'));
  fs.writeFileSync(path.join(workspace, 'message.md.tmpl'), 'Hello\n');
  const base = {
    GITHUB_WORKSPACE: workspace,
    INPUT_MODE: 'send',
    INPUT_PROVIDERS: 'telegram',
    INPUT_TEMPLATE_PATH: 'message.md.tmpl',
    INPUT_TELEGRAM_BOT_TOKEN: '123456:test-token',
  };

  const config = notify.buildConfiguration({
    ...base,
    INPUT_TELEGRAM_TARGETS: '{"targets":[{"chatId":"263420264"}]}',
  });
  assert.deepEqual(config.telegram.targets, [{ chatId: '263420264', threadId: '' }]);

  assert.throws(() => notify.buildConfiguration({
    ...base,
    INPUT_TELEGRAM_TARGETS: '[{"chatId":"263420264"}]',
  }), /telegram-targets must be a JSON object/);
  assert.throws(() => notify.buildConfiguration({
    ...base,
    INPUT_TELEGRAM_TARGETS: '{"targets":[],"unknown":true}',
  }), /unsupported property "unknown"/);
});

test('requestWithRetry retries retryable responses and respects Retry-After', async () => {
  const originalFetch = global.fetch;
  const waits = [];
  const responses = [
    new Response('', { headers: { 'retry-after': '0' }, status: 429 }),
    new Response('', { status: 200 }),
  ];
  global.fetch = async () => responses.shift();
  try {
    const result = await notify.requestWithRetry({
      createRequest: () => ({ init: {}, url: 'https://example.test' }),
      label: 'test',
      maxAttempts: 3,
      timeoutMs: 1_000,
      wait: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(result.attempt, 2);
    assert.deepEqual(waits, [0]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('retry status classification excludes ordinary client errors', () => {
  assert.equal(notify.shouldRetryStatus(429), true);
  assert.equal(notify.shouldRetryStatus(503), true);
  assert.equal(notify.shouldRetryStatus(400), false);
});

test('Retry-After supports seconds and dates', () => {
  assert.equal(notify.parseRetryAfter('1.5'), 1_500);
  assert.equal(notify.parseRetryAfter('invalid'), null);
});
