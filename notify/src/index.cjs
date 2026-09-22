import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as core from '@actions/core';
import MarkdownIt from 'markdown-it';

const MAX_TEXT_FILE_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const PROVIDER_LIMITS = Object.freeze({ discord: 2_000, telegram: 4_096 });
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TEXT_TOKEN_PATTERN = /\u{e000}(\d+)\u{e001}/gu;
const URL_TOKEN_PATTERN = /\u{e002}(\d+)\u{e003}/gu;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
const ALLOWED_MARKDOWN_TOKENS = new Set([
  'blockquote_close',
  'blockquote_open',
  'bullet_list_close',
  'bullet_list_open',
  'code_block',
  'code_inline',
  'em_close',
  'em_open',
  'fence',
  'hardbreak',
  'heading_close',
  'heading_open',
  'inline',
  'link_close',
  'link_open',
  'list_item_close',
  'list_item_open',
  'ordered_list_close',
  'ordered_list_open',
  'paragraph_close',
  'paragraph_open',
  's_close',
  's_open',
  'softbreak',
  'strong_close',
  'strong_open',
  'text',
]);

class ConfigurationError extends Error {}

function configurationError(message) {
  throw new ConfigurationError(message);
}

function inputName(name) {
  return `INPUT_${name.replaceAll(' ', '_').toUpperCase()}`;
}

function getInput(env, name, fallback = '') {
  const value = env[inputName(name)];
  return value === undefined || value === '' ? fallback : value;
}

function parseChoice(value, name, choices) {
  if (!choices.includes(value)) {
    configurationError(`${name} must be one of: ${choices.join(', ')}.`);
  }
  return value;
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  configurationError(`${name} must be true or false.`);
}

function parseInteger(value, name, minimum, maximum) {
  if (!/^\d+$/.test(String(value))) configurationError(`${name} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    configurationError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return result;
}

function parseProviders(value) {
  const providers = [];
  for (const rawProvider of String(value).split(',')) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider) continue;
    if (!Object.hasOwn(PROVIDER_LIMITS, provider)) {
      configurationError(`Unsupported notification provider: ${provider}.`);
    }
    if (!providers.includes(provider)) providers.push(provider);
  }
  if (providers.length === 0) configurationError('At least one provider must be enabled.');
  return providers;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJson(value, name) {
  try {
    return JSON.parse(value);
  } catch (error) {
    configurationError(`${name} must contain valid JSON: ${error.message}`);
  }
}

function validateVariableTree(value, name = 'variables') {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!isPlainObject(value)) {
    configurationError(`${name} must contain only objects and scalar JSON values.`);
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      configurationError(`${name} contains an invalid key: ${key}.`);
    }
    validateVariableTree(child, `${name}.${key}`);
  }
}

function parseVariables(value) {
  const variables = parseJson(value || '{}', 'variables');
  if (!isPlainObject(variables)) configurationError('variables must be a JSON object.');
  validateVariableTree(variables);
  for (const reserved of ['github', 'qr_url']) {
    if (Object.hasOwn(variables, reserved)) {
      configurationError(`variables cannot replace reserved value "${reserved}".`);
    }
  }
  return variables;
}

function resolveWorkspacePath(workspace, inputPath, name, options = {}) {
  if (!inputPath) configurationError(`${name} is required.`);
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, inputPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    configurationError(`${name} must resolve inside the caller workspace.`);
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    configurationError(`Cannot read ${name} "${inputPath}": ${error.message}`);
  }
  if (!stat.isFile()) configurationError(`${name} must reference a regular file.`);
  const limit = options.maxBytes ?? MAX_TEXT_FILE_BYTES;
  if (stat.size > limit) configurationError(`${name} exceeds the ${limit}-byte limit.`);
  return { resolved, size: stat.size };
}

function readTextFile(workspace, inputPath, name) {
  const { resolved } = resolveWorkspacePath(workspace, inputPath, name);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(resolved));
  } catch {
    configurationError(`${name} must contain valid UTF-8 text.`);
  }
  if (source.includes('\0')) configurationError(`${name} must not contain NUL bytes.`);
  return source;
}

function readJsonFile(workspace, inputPath, name) {
  const value = parseJson(readTextFile(workspace, inputPath, name), name);
  if (!isPlainObject(value)) configurationError(`${name} must contain a JSON object.`);
  return value;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function parseTemplate(source, sourceName = 'template') {
  const root = [];
  const stack = [{ name: null, nodes: root }];
  const pattern = /{{\s*(#if\s+[^{}]+|\/if|url\s+[^{}]+|[^{}]+)\s*}}/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > offset) stack.at(-1).nodes.push({ type: 'text', value: source.slice(offset, match.index) });
    const expression = match[1].trim();
    const line = lineAt(source, match.index);
    if (expression.startsWith('#if ')) {
      const name = expression.slice(4).trim();
      if (!PLACEHOLDER_NAME.test(name)) configurationError(`${sourceName}:${line}: invalid conditional variable.`);
      const node = { type: 'if', name, nodes: [], line };
      stack.at(-1).nodes.push(node);
      stack.push({ name, nodes: node.nodes, line });
    } else if (expression === '/if') {
      if (stack.length === 1) configurationError(`${sourceName}:${line}: unmatched {{/if}}.`);
      stack.pop();
    } else {
      const url = expression.startsWith('url ');
      const name = url ? expression.slice(4).trim() : expression;
      if (!PLACEHOLDER_NAME.test(name)) {
        configurationError(`${sourceName}:${line}: unsupported template expression "${expression}".`);
      }
      stack.at(-1).nodes.push({ type: url ? 'url' : 'variable', name, line });
    }
    offset = match.index + match[0].length;
  }
  if (offset < source.length) stack.at(-1).nodes.push({ type: 'text', value: source.slice(offset) });
  if (stack.length !== 1) {
    configurationError(`${sourceName}:${stack.at(-1).line}: missing {{/if}} for "${stack.at(-1).name}".`);
  }
  if (/{{|}}/.test(source.replace(pattern, ''))) {
    configurationError(`${sourceName}: malformed or unsupported placeholder.`);
  }
  return root;
}

function getValue(values, name, sourceName, line) {
  let current = values;
  for (const component of name.split('.')) {
    if (!isPlainObject(current) || !Object.hasOwn(current, component)) {
      configurationError(`${sourceName}:${line}: unknown template variable "${name}".`);
    }
    current = current[component];
  }
  if (isPlainObject(current)) {
    configurationError(`${sourceName}:${line}: template variable "${name}" is an object.`);
  }
  return current;
}

function isTruthy(value) {
  return value !== null && value !== false && value !== '' && value !== 0;
}

function validateTemplateVariables(nodes, values, sourceName) {
  for (const node of nodes) {
    if (node.type === 'variable' || node.type === 'url') {
      getValue(values, node.name, sourceName, node.line);
    }
    if (node.type === 'if') {
      getValue(values, node.name, sourceName, node.line);
      validateTemplateVariables(node.nodes, values, sourceName);
    }
  }
}

function requireHttpUrl(value, name = 'URL') {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    configurationError(`${name} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    configurationError(`${name} must use HTTP or HTTPS.`);
  }
  return parsed.toString();
}

function renderTokenized(nodes, values, sourceName, tokens) {
  let output = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      output += node.value;
    } else if (node.type === 'variable') {
      const value = getValue(values, node.name, sourceName, node.line);
      const index = tokens.text.push(value === null ? '' : String(value)) - 1;
      output += `\u{e000}${index}\u{e001}`;
    } else if (node.type === 'url') {
      const value = getValue(values, node.name, sourceName, node.line);
      const url = requireHttpUrl(value, `${sourceName}:${node.line}: {{url ${node.name}}}`);
      const index = tokens.urls.push(url) - 1;
      output += `\u{e002}${index}\u{e003}`;
    } else if (node.type === 'if' && isTruthy(getValue(values, node.name, sourceName, node.line))) {
      output += renderTokenized(node.nodes, values, sourceName, tokens);
    }
  }
  return output;
}

function replaceUrlTokens(source, urls) {
  return source.replace(URL_TOKEN_PATTERN, (_match, index) => (
    urls[Number(index)] ?? ''
  ).replaceAll('(', '%28').replaceAll(')', '%29'));
}

function createMarkdownParser() {
  return new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
}

function validateMarkdownTokens(tokens, sourceName) {
  for (const token of tokens) {
    if (!ALLOWED_MARKDOWN_TOKENS.has(token.type)) {
      const line = token.map ? token.map[0] + 1 : 1;
      configurationError(`${sourceName}:${line}: unsupported Markdown construct "${token.type}".`);
    }
    if (token.type === 'link_open') {
      requireHttpUrl(token.attrGet('href'), `${sourceName}: link destination`);
    }
    if (token.children) validateMarkdownTokens(token.children, sourceName);
  }
}

function escapeDiscord(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replace(/([`*_{}\[\]()#+\-.!|<>~])/g, '\\$1');
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function replaceTextTokens(source, text, escapeValue) {
  return source.replace(TEXT_TOKEN_PATTERN, (_match, index) => escapeValue(text[Number(index)] ?? ''));
}

function renderTelegramTokens(tokens, textValues, state = { lists: [] }) {
  let output = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'blockquote_open': output += '<blockquote>'; break;
      case 'blockquote_close': output += '</blockquote>\n'; break;
      case 'bullet_list_open': state.lists.push({ ordered: false }); break;
      case 'bullet_list_close': state.lists.pop(); break;
      case 'ordered_list_open': state.lists.push({ ordered: true, value: Number(token.attrGet('start') ?? 1) }); break;
      case 'ordered_list_close': state.lists.pop(); break;
      case 'list_item_open': {
        const list = state.lists.at(-1);
        if (list?.ordered) {
          output += `${list.value}. `;
          list.value += 1;
        } else {
          output += '• ';
        }
        break;
      }
      case 'list_item_close': output += '\n'; break;
      case 'heading_open': output += '<b>'; break;
      case 'heading_close': output += '</b>\n'; break;
      case 'paragraph_open': break;
      case 'paragraph_close':
        if (state.lists.length === 0) output += '\n';
        break;
      case 'strong_open': output += '<b>'; break;
      case 'strong_close': output += '</b>'; break;
      case 'em_open': output += '<i>'; break;
      case 'em_close': output += '</i>'; break;
      case 's_open': output += '<s>'; break;
      case 's_close': output += '</s>'; break;
      case 'code_inline': output += `<code>${replaceTextTokens(token.content, textValues, escapeHtml)}</code>`; break;
      case 'fence':
      case 'code_block':
        output += `<pre><code>${replaceTextTokens(token.content, textValues, escapeHtml)}</code></pre>\n`;
        break;
      case 'link_open': output += `<a href="${escapeHtmlAttribute(token.attrGet('href'))}">`; break;
      case 'link_close': output += '</a>'; break;
      case 'softbreak': output += '\n'; break;
      case 'hardbreak': output += '\n'; break;
      case 'text': output += replaceTextTokens(token.content, textValues, escapeHtml); break;
      case 'inline': output += renderTelegramTokens(token.children ?? [], textValues, state); break;
      default: break;
    }
  }
  return output.replace(/\n{3,}/g, '\n\n').trim();
}

function renderTemplate(source, values, provider, sourceName = 'template') {
  const nodes = parseTemplate(source, sourceName);
  validateTemplateVariables(nodes, values, sourceName);
  const valuesByType = { text: [], urls: [] };
  const tokenized = replaceUrlTokens(renderTokenized(nodes, values, sourceName, valuesByType), valuesByType.urls);
  const parsed = createMarkdownParser().parse(tokenized, {});
  validateMarkdownTokens(parsed, sourceName);
  const message = provider === 'discord'
    ? replaceTextTokens(tokenized, valuesByType.text, escapeDiscord).trim()
    : renderTelegramTokens(parsed, valuesByType.text);
  if (!message) configurationError(`${sourceName} rendered an empty ${provider} message.`);
  if (message.length > PROVIDER_LIMITS[provider]) {
    configurationError(
      `${sourceName} rendered ${message.length} ${provider} characters; limit is ${PROVIDER_LIMITS[provider]}.`,
    );
  }
  return message;
}

function parseDiscordWebhooks(raw, mode) {
  const value = parseJson(raw, 'discord-webhooks');
  if (!isPlainObject(value)) configurationError('discord-webhooks must be a JSON object.');
  const unknownRoot = Object.keys(value).find((key) => key !== 'targets');
  if (unknownRoot) {
    configurationError(`discord-webhooks contains unsupported property "${unknownRoot}".`);
  }
  if (!Array.isArray(value.targets)) {
    configurationError('discord-webhooks.targets must be a JSON array.');
  }
  const webhooks = [];
  const seen = new Set();
  for (const [index, item] of value.targets.entries()) {
    if (!isPlainObject(item)) {
      configurationError(`discord-webhooks.targets[${index}] must be an object.`);
    }
    const unknown = Object.keys(item).find((key) => key !== 'url');
    if (unknown) {
      configurationError(
        `discord-webhooks.targets[${index}] contains unsupported property "${unknown}".`,
      );
    }
    if (typeof item.url !== 'string' || item.url.length === 0) {
      configurationError(`discord-webhooks.targets[${index}].url must be a non-empty string.`);
    }
    const parsed = requireHttpUrl(item.url, `discord-webhooks.targets[${index}].url`);
    if (!['discord.com', 'discordapp.com'].includes(new URL(parsed).hostname)) {
      configurationError('Discord webhook host must be discord.com or discordapp.com.');
    }
    core.setSecret(item.url);
    if (!seen.has(item.url)) webhooks.push(item.url);
    seen.add(item.url);
  }
  if (mode === 'send' && webhooks.length === 0) {
    configurationError('discord-webhooks.targets must contain a target.');
  }
  return webhooks;
}

function parseTelegramTargets(raw, mode) {
  const value = parseJson(raw, 'telegram-targets');
  if (!isPlainObject(value)) configurationError('telegram-targets must be a JSON object.');
  const unknownRoot = Object.keys(value).find((key) => key !== 'targets');
  if (unknownRoot) {
    configurationError(`telegram-targets contains unsupported property "${unknownRoot}".`);
  }
  if (!Array.isArray(value.targets)) {
    configurationError('telegram-targets.targets must be a JSON array.');
  }
  const targets = [];
  const seen = new Set();
  for (const [index, item] of value.targets.entries()) {
    if (!isPlainObject(item)) {
      configurationError(`telegram-targets.targets[${index}] must be an object.`);
    }
    const allowed = new Set(['chatId', 'threadId']);
    const unknown = Object.keys(item).find((key) => !allowed.has(key));
    if (unknown) {
      configurationError(
        `telegram-targets.targets[${index}] contains unsupported property "${unknown}".`,
      );
    }
    const chatId = String(item.chatId ?? '');
    if (!/^-?\d+$/.test(chatId)) {
      configurationError(`telegram-targets.targets[${index}].chatId must be an integer.`);
    }
    const threadId = item.threadId === undefined ? '' : String(item.threadId);
    if (threadId && !/^\d+$/.test(threadId)) {
      configurationError(
        `telegram-targets.targets[${index}].threadId must be a positive integer.`,
      );
    }
    const key = `${chatId}:${threadId}`;
    if (!seen.has(key)) targets.push({ chatId, threadId });
    seen.add(key);
  }
  if (mode === 'send' && targets.length === 0) {
    configurationError('telegram-targets.targets must contain a target.');
  }
  return targets;
}

function parseAttachments(raw, workspace) {
  const value = parseJson(raw, 'attachments');
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    configurationError(`attachments must be a JSON array with at most ${MAX_ATTACHMENTS} entries.`);
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) configurationError(`attachments[${index}] must be an object.`);
    const allowed = new Set(['caption', 'kind', 'name', 'path', 'providers', 'url']);
    const unknown = Object.keys(item).find((key) => !allowed.has(key));
    if (unknown) configurationError(`attachments[${index}] contains unsupported property "${unknown}".`);
    if ((typeof item.path === 'string') === (typeof item.url === 'string')) {
      configurationError(`attachments[${index}] must define exactly one of path or url.`);
    }
    const providers = item.providers ?? ['discord', 'telegram'];
    if (!Array.isArray(providers) || providers.some((provider) => !['discord', 'telegram'].includes(provider))) {
      configurationError(`attachments[${index}].providers must contain discord and/or telegram.`);
    }
    const kind = item.kind ?? 'document';
    if (!['document', 'photo'].includes(kind)) {
      configurationError(`attachments[${index}].kind must be document or photo.`);
    }
    let resolvedPath = '';
    let size = 0;
    if (item.path) {
      const resolved = resolveWorkspacePath(workspace, item.path, `attachments[${index}].path`, {
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      resolvedPath = resolved.resolved;
      size = resolved.size;
    }
    const url = item.url ? requireHttpUrl(item.url, `attachments[${index}].url`) : '';
    if (url && providers.includes('discord')) {
      configurationError(`attachments[${index}] uses a URL, which Discord uploads do not accept.`);
    }
    if (item.name !== undefined && (typeof item.name !== 'string' || path.basename(item.name) !== item.name)) {
      configurationError(`attachments[${index}].name must be a plain file name.`);
    }
    if (item.caption !== undefined && typeof item.caption !== 'string') {
      configurationError(`attachments[${index}].caption must be a string.`);
    }
    return {
      caption: item.caption ?? '',
      kind,
      name: item.name || (resolvedPath ? path.basename(resolvedPath) : ''),
      path: resolvedPath,
      providers: [...new Set(providers)],
      size,
      url,
    };
  });
}

function validateDiscordPayload(payload, hasTemplate) {
  const forbidden = ['allowed_mentions', 'attachments', 'file', 'files', 'thread_id', 'webhook_url'];
  const key = forbidden.find((item) => Object.hasOwn(payload, item));
  if (key) configurationError(`discord-payload-path cannot set protected property "${key}".`);
  if (hasTemplate && Object.hasOwn(payload, 'content')) {
    configurationError('Discord payload content conflicts with the selected template.');
  }
  if (Object.hasOwn(payload, 'content')) {
    if (typeof payload.content !== 'string' || payload.content.length > PROVIDER_LIMITS.discord) {
      configurationError(`Discord native content must be a string with at most ${PROVIDER_LIMITS.discord} characters.`);
    }
  }
  return payload;
}

function validateTelegramPayload(payload, hasTemplate) {
  const allowedRoot = new Set(['body', 'method']);
  const unknownRoot = Object.keys(payload).find((key) => !allowedRoot.has(key));
  if (unknownRoot) configurationError(`telegram-payload-path contains unsupported property "${unknownRoot}".`);
  const method = payload.method ?? 'sendMessage';
  if (!['sendDocument', 'sendMessage', 'sendPhoto'].includes(method)) {
    configurationError('Telegram native method must be sendMessage, sendPhoto, or sendDocument.');
  }
  const body = payload.body ?? {};
  if (!isPlainObject(body)) configurationError('Telegram native body must be an object.');
  for (const protectedKey of ['chat_id', 'message_thread_id', 'parse_mode']) {
    if (Object.hasOwn(body, protectedKey)) {
      configurationError(`Telegram native body cannot set protected property "${protectedKey}".`);
    }
  }
  const contentKey = method === 'sendMessage' ? 'text' : 'caption';
  if (hasTemplate && Object.hasOwn(body, contentKey)) {
    configurationError(`Telegram native body ${contentKey} conflicts with the selected template.`);
  }
  if (Object.hasOwn(body, contentKey) && typeof body[contentKey] !== 'string') {
    configurationError(`Telegram native body ${contentKey} must be a string.`);
  }
  if (method === 'sendMessage' && !hasTemplate && !Object.hasOwn(body, 'text')) {
    configurationError('Telegram native sendMessage requires body.text when no template is selected.');
  }
  if (method === 'sendPhoto' && !Object.hasOwn(body, 'photo')) {
    configurationError('Telegram native sendPhoto requires body.photo.');
  }
  if (method === 'sendDocument' && !Object.hasOwn(body, 'document')) {
    configurationError('Telegram native sendDocument requires body.document.');
  }
  return { method, body };
}

function buildValues(env, variables, qrUrl) {
  const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
  const repository = env.GITHUB_REPOSITORY || '';
  const runId = env.GITHUB_RUN_ID || '';
  return {
    ...variables,
    github: {
      actor: env.GITHUB_ACTOR || '',
      event_name: env.GITHUB_EVENT_NAME || '',
      job: env.GITHUB_JOB || '',
      ref: env.GITHUB_REF || '',
      ref_name: env.GITHUB_REF_NAME || '',
      repository,
      run_id: runId,
      run_number: env.GITHUB_RUN_NUMBER || '',
      run_url: repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : '',
      server_url: serverUrl,
      sha: env.GITHUB_SHA || '',
      workflow: env.GITHUB_WORKFLOW || '',
    },
    qr_url: qrUrl,
  };
}

function buildConfiguration(env = process.env) {
  const mode = parseChoice(getInput(env, 'mode', 'send'), 'mode', ['render', 'send', 'validate']);
  const providers = parseProviders(getInput(env, 'providers', 'discord,telegram'));
  const failurePolicy = parseChoice(
    getInput(env, 'failure-policy', 'required'),
    'failure-policy',
    ['best-effort', 'required'],
  );
  const timeoutMs = parseInteger(getInput(env, 'timeout-ms', '10000'), 'timeout-ms', 100, 120_000);
  const maxAttempts = parseInteger(getInput(env, 'max-attempts', '5'), 'max-attempts', 1, 10);
  const discordTts = parseBoolean(getInput(env, 'discord-tts', 'false'), 'discord-tts');
  const telegramDisableLinkPreview = parseBoolean(
    getInput(env, 'telegram-disable-link-preview', 'true'),
    'telegram-disable-link-preview',
  );
  const telegramSilent = parseBoolean(getInput(env, 'telegram-silent', 'false'), 'telegram-silent');
  const sendQr = parseBoolean(getInput(env, 'send-qr', 'false'), 'send-qr');
  const qrDataIsPublic = parseBoolean(getInput(env, 'qr-data-is-public', 'false'), 'qr-data-is-public');
  const variables = parseVariables(getInput(env, 'variables', '{}'));
  const workspace = path.resolve(env.GITHUB_WORKSPACE || process.cwd());
  const templatePaths = {
    discord: getInput(env, 'discord-template-path') || getInput(env, 'template-path'),
    telegram: getInput(env, 'telegram-template-path') || getInput(env, 'template-path'),
  };
  const payloadPaths = {
    discord: getInput(env, 'discord-payload-path'),
    telegram: getInput(env, 'telegram-payload-path'),
  };
  const qrData = getInput(env, 'qr-data');
  if (sendQr && !qrData) configurationError('send-qr requires qr-data.');
  if (sendQr && !qrDataIsPublic) configurationError('send-qr requires qr-data-is-public to be true.');
  const qrUrl = sendQr
    ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(qrData)}`
    : '';
  const values = buildValues(env, variables, qrUrl);
  const templates = {};
  const payloads = {};
  for (const provider of providers) {
    if (!templatePaths[provider] && !payloadPaths[provider]) {
      configurationError(`${provider} requires a template path or native payload path.`);
    }
    templates[provider] = templatePaths[provider]
      ? {
          name: templatePaths[provider],
          source: readTextFile(workspace, templatePaths[provider], `${provider} template`),
        }
      : null;
    const nativePayload = payloadPaths[provider]
      ? readJsonFile(workspace, payloadPaths[provider], `${provider} payload`)
      : {};
    payloads[provider] = provider === 'discord'
      ? validateDiscordPayload(nativePayload, Boolean(templates[provider]))
      : validateTelegramPayload(nativePayload, Boolean(templates[provider]));
  }

  const discordWebhooks = providers.includes('discord')
    ? parseDiscordWebhooks(getInput(env, 'discord-webhooks', '{"targets":[]}'), mode)
    : [];
  const telegramToken = getInput(env, 'telegram-bot-token');
  if (telegramToken) core.setSecret(telegramToken);
  const telegramTargets = providers.includes('telegram')
    ? parseTelegramTargets(getInput(env, 'telegram-targets', '{"targets":[]}'), mode)
    : [];
  if (mode === 'send' && providers.includes('telegram') && !telegramToken) {
    configurationError('telegram-bot-token is required for send mode.');
  }
  const discordAvatarUrl = getInput(env, 'discord-avatar-url');
  if (discordAvatarUrl) requireHttpUrl(discordAvatarUrl, 'discord-avatar-url');
  const attachments = parseAttachments(getInput(env, 'attachments', '[]'), workspace);
  if (sendQr) {
    attachments.push({
      caption: getInput(env, 'qr-caption'),
      kind: 'photo',
      name: '',
      path: '',
      providers: ['telegram'],
      size: 0,
      url: qrUrl,
    });
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    configurationError(`attachments plus QR must not exceed ${MAX_ATTACHMENTS} entries.`);
  }

  return {
    attachments,
    discord: {
      avatarUrl: discordAvatarUrl,
      tts: discordTts,
      username: getInput(env, 'discord-username'),
      webhooks: discordWebhooks,
    },
    failurePolicy,
    maxAttempts,
    mode,
    payloads,
    providers,
    qrUrl,
    renderOutputDirectory: getInput(env, 'render-output-directory'),
    telegram: {
      disableLinkPreview: telegramDisableLinkPreview,
      silent: telegramSilent,
      targets: telegramTargets,
      token: telegramToken,
    },
    templates,
    timeoutMs,
    values,
    workspace,
  };
}

function hashMessage(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.ceil(Number(value) * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function shouldRetryStatus(status) {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestWithRetry({ createRequest, maxAttempts, timeoutMs, label, wait = delay }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const request = createRequest();
      const response = await fetch(request.url, { ...request.init, signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok || !shouldRetryStatus(response.status) || attempt === maxAttempts) {
        return { attempt, response };
      }
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const waitMs = Math.min(retryAfter ?? 500 * (2 ** (attempt - 1)), 30_000);
      core.warning(`${label} returned HTTP ${response.status}; retrying attempt ${attempt + 1}.`);
      await wait(waitMs);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt === maxAttempts) break;
      core.warning(`${label} request failed; retrying attempt ${attempt + 1}.`);
      await wait(Math.min(500 * (2 ** (attempt - 1)), 30_000));
    }
  }
  const error = new Error(`${label} request failed after ${maxAttempts} attempts: ${lastError?.message ?? 'network error'}.`);
  error.attempts = maxAttempts;
  throw error;
}

function discordPayload(config, message) {
  return {
    ...config.payloads.discord,
    ...(message ? { content: message } : {}),
    ...(config.discord.username ? { username: config.discord.username } : {}),
    ...(config.discord.avatarUrl ? { avatar_url: config.discord.avatarUrl } : {}),
    ...(config.discord.tts ? { tts: true } : {}),
    allowed_mentions: { parse: [] },
  };
}

function createDiscordRequest(config, webhook, message) {
  const attachments = config.attachments.filter((attachment) => attachment.providers.includes('discord'));
  const payload = discordPayload(config, message);
  if (attachments.length === 0) {
    return {
      url: webhook,
      init: {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    };
  }
  const form = new FormData();
  form.set('payload_json', JSON.stringify(payload));
  attachments.forEach((attachment, index) => {
    form.set(`files[${index}]`, new Blob([fs.readFileSync(attachment.path)]), attachment.name);
  });
  return { url: webhook, init: { body: form, method: 'POST' } };
}

async function sendDiscord(config, webhook, message) {
  const result = await requestWithRetry({
    createRequest: () => createDiscordRequest(config, webhook, message),
    label: 'Discord',
    maxAttempts: config.maxAttempts,
    timeoutMs: config.timeoutMs,
  });
  if (!result.response.ok) {
    const error = new Error(`Discord returned HTTP ${result.response.status}.`);
    error.attempts = result.attempt;
    throw error;
  }
  return result.attempt;
}

function telegramBase(target) {
  return {
    chat_id: target.chatId,
    ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
  };
}

async function telegramJsonRequest(config, target, method, body, label) {
  const endpoint = `https://api.telegram.org/bot${config.telegram.token}/${method}`;
  const result = await requestWithRetry({
    createRequest: () => ({
      url: endpoint,
      init: {
        body: JSON.stringify({ ...telegramBase(target), ...body }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    }),
    label,
    maxAttempts: config.maxAttempts,
    timeoutMs: config.timeoutMs,
  });
  let responseBody;
  try {
    responseBody = await result.response.json();
  } catch {
    const error = new Error(`${label} returned invalid JSON (HTTP ${result.response.status}).`);
    error.attempts = result.attempt;
    throw error;
  }
  if (!result.response.ok || responseBody.ok !== true) {
    const error = new Error(`${label} rejected the request (HTTP ${result.response.status}).`);
    error.attempts = result.attempt;
    throw error;
  }
  return result.attempt;
}

async function telegramAttachmentRequest(config, target, attachment) {
  const method = attachment.kind === 'photo' ? 'sendPhoto' : 'sendDocument';
  const mediaKey = attachment.kind === 'photo' ? 'photo' : 'document';
  if (attachment.url) {
    return telegramJsonRequest(config, target, method, {
      [mediaKey]: attachment.url,
      ...(attachment.caption ? { caption: attachment.caption } : {}),
    }, `Telegram ${method}`);
  }
  const endpoint = `https://api.telegram.org/bot${config.telegram.token}/${method}`;
  const result = await requestWithRetry({
    createRequest: () => {
      const form = new FormData();
      form.set('chat_id', target.chatId);
      if (target.threadId) form.set('message_thread_id', target.threadId);
      if (attachment.caption) form.set('caption', attachment.caption);
      form.set(mediaKey, new Blob([fs.readFileSync(attachment.path)]), attachment.name);
      return { url: endpoint, init: { body: form, method: 'POST' } };
    },
    label: `Telegram ${method}`,
    maxAttempts: config.maxAttempts,
    timeoutMs: config.timeoutMs,
  });
  if (!result.response.ok) {
    const error = new Error(`Telegram ${method} returned HTTP ${result.response.status}.`);
    error.attempts = result.attempt;
    throw error;
  }
  return result.attempt;
}

async function sendTelegram(config, target, message) {
  const native = config.payloads.telegram;
  const contentKey = native.method === 'sendMessage' ? 'text' : 'caption';
  let attempts = 0;
  try {
    attempts += await telegramJsonRequest(config, target, native.method, {
      ...native.body,
      ...(message ? { [contentKey]: message } : {}),
      ...(native.method === 'sendMessage'
        ? {
            disable_notification: config.telegram.silent,
            link_preview_options: { is_disabled: config.telegram.disableLinkPreview },
            parse_mode: 'HTML',
          }
        : {}),
    }, `Telegram ${native.method}`);
    for (const attachment of config.attachments.filter((item) => item.providers.includes('telegram'))) {
      attempts += await telegramAttachmentRequest(config, target, attachment);
    }
  } catch (error) {
    error.attempts = attempts + (error.attempts ?? 1);
    throw error;
  }
  return attempts;
}

function renderMessages(config) {
  const messages = {};
  for (const provider of config.providers) {
    const template = config.templates[provider];
    messages[provider] = template
      ? renderTemplate(template.source, config.values, provider, template.name)
      : '';
  }
  return messages;
}

function safeMessageMetadata(messages) {
  return Object.fromEntries(Object.entries(messages).map(([provider, message]) => [provider, {
    length: message.length,
    sha256: hashMessage(message),
  }]));
}

function writeRenderedFiles(config, messages) {
  const base = config.renderOutputDirectory
    ? path.resolve(config.workspace, config.renderOutputDirectory)
    : path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'ziqq-notify-rendered');
  if (config.renderOutputDirectory) {
    const relative = path.relative(config.workspace, base);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      configurationError('render-output-directory must stay inside the caller workspace.');
    }
  }
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const files = [];
  for (const [provider, message] of Object.entries(messages)) {
    const file = path.join(base, `${provider}.${provider === 'telegram' ? 'html' : 'md'}`);
    fs.writeFileSync(file, `${message}\n`, { encoding: 'utf8', mode: 0o600 });
    files.push(file);
  }
  return files;
}

async function run(config) {
  const messages = renderMessages(config);
  const metadata = safeMessageMetadata(messages);
  core.setOutput('message-metadata', JSON.stringify(metadata));
  if (config.mode === 'validate') {
    core.info(`Validated providers: ${config.providers.join(', ')}.`);
    core.setOutput('delivery-results', '[]');
    core.setOutput('rendered-files', '[]');
    return { messages, results: [] };
  }
  if (config.mode === 'render') {
    const files = writeRenderedFiles(config, messages);
    core.info(`Rendered ${files.length} provider file(s); message bodies were not logged.`);
    core.setOutput('delivery-results', '[]');
    core.setOutput('rendered-files', JSON.stringify(files));
    return { messages, results: [], files };
  }

  const results = [];
  if (config.providers.includes('discord')) {
    for (const [index, webhook] of config.discord.webhooks.entries()) {
      try {
        const attempts = await sendDiscord(config, webhook, messages.discord);
        results.push({ attempts, provider: 'discord', status: 'delivered', target: index + 1 });
        core.info(`Discord target ${index + 1} delivered.`);
      } catch (error) {
        results.push({ attempts: error.attempts ?? 1, provider: 'discord', status: 'failed', target: index + 1 });
        core.error(`Discord target ${index + 1} failed: ${error.message}`);
      }
    }
  }
  if (config.providers.includes('telegram')) {
    for (const [index, target] of config.telegram.targets.entries()) {
      try {
        const attempts = await sendTelegram(config, target, messages.telegram);
        results.push({ attempts, provider: 'telegram', status: 'delivered', target: index + 1 });
        core.info(`Telegram target ${index + 1} delivered.`);
      } catch (error) {
        results.push({ attempts: error.attempts ?? 1, provider: 'telegram', status: 'failed', target: index + 1 });
        core.error(`Telegram target ${index + 1} failed: ${error.message}`);
      }
    }
  }
  core.setOutput('delivery-results', JSON.stringify(results));
  core.setOutput('rendered-files', '[]');
  const failures = results.filter((result) => result.status === 'failed');
  if (failures.length > 0) {
    const message = `${failures.length} of ${results.length} notification target(s) failed.`;
    if (config.failurePolicy === 'required') throw new Error(message);
    core.warning(message);
  }
  return { messages, results };
}

async function main(env = process.env) {
  const config = buildConfiguration(env);
  return run(config);
}

if (require.main === module) {
  main().catch((error) => {
    core.setFailed(error instanceof ConfigurationError ? `Configuration error: ${error.message}` : error.message);
  });
}

export {
  ConfigurationError,
  buildConfiguration,
  main,
  parseRetryAfter,
  parseTemplate,
  renderTemplate,
  requestWithRetry,
  run,
  shouldRetryStatus,
};
