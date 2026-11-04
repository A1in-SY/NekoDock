import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const capabilities = new Set(['commands', 'content-enrichment', 'video-download']);
const resourceTypes = new Set(['video', 'article', 'post', 'live', 'game']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (directory, field, reason) => { throw new Error(`Invalid plugin declaration ${directory}: ${field} ${reason}`); };
const keys = (value, known, directory, field) => {
  if (!object(value)) fail(directory, field, 'must be an object');
  if (Object.keys(value).some(key => !known.includes(key))) fail(directory, field, 'contains an unknown property');
};
const text = (value, directory, field, limit = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail(directory, field, 'must be nonempty text');
  return value;
};
const list = (value, accepted, directory, field) => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !accepted.has(item)) || new Set(value).size !== value.length) fail(directory, field, 'contains an unsupported or duplicate value');
  return value;
};
const contained = (parent, path) => {
  const remainder = relative(parent, path);
  return remainder !== '' && !isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep);
};

function configSchema(value, directory) {
  keys(value, ['type', 'properties'], directory, 'configSchema');
  if (value.type !== 'object' || !object(value.properties) || Object.keys(value.properties).length > 128) fail(directory, 'configSchema', 'must describe an object with at most 128 properties');
  for (const [name, field] of Object.entries(value.properties)) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) fail(directory, 'configSchema.properties', 'contains an invalid field name');
    const path = `configSchema.properties.${name}`;
    keys(field, ['type', 'title', 'description', 'minimum', 'maximum', 'default', 'secret', 'enum', 'enumLabels', 'group'], directory, path);
    if (!['boolean', 'integer', 'string'].includes(field.type)) fail(directory, path + '.type', 'is unsupported');
    text(field.title, directory, path + '.title', 160);
    if (field.description !== undefined) text(field.description, directory, path + '.description');
    if (field.group !== undefined) text(field.group, directory, path + '.group', 80);
    if (field.secret !== undefined && typeof field.secret !== 'boolean') fail(directory, path + '.secret', 'must be boolean');
    if (field.secret && field.type !== 'string') fail(directory, path + '.secret', 'requires a string field');
    if (field.enum !== undefined) {
      if (field.type !== 'string' || field.secret || !Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || new Set(field.enum).size !== field.enum.length) fail(directory, path + '.enum', 'requires distinct non-secret string options');
      for (const option of field.enum) text(option, directory, path + '.enum', 160);
    }
    if (field.enumLabels !== undefined) {
      if (!Array.isArray(field.enum) || !Array.isArray(field.enumLabels) || field.enumLabels.length !== field.enum.length) fail(directory, path + '.enumLabels', 'must match enum options');
      for (const label of field.enumLabels) text(label, directory, path + '.enumLabels', 160);
    }
    for (const bound of ['minimum', 'maximum']) if (field[bound] !== undefined && (field.type !== 'integer' || !Number.isSafeInteger(field[bound]))) fail(directory, path + '.' + bound, 'requires a safe integer field');
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) fail(directory, path, 'has an inverted range');
    if (field.default !== undefined) {
      const valid = field.type === 'integer' ? Number.isSafeInteger(field.default) && (field.minimum === undefined || field.default >= field.minimum) && (field.maximum === undefined || field.default <= field.maximum)
        : typeof field.default === field.type;
      if (!valid || field.secret || field.enum && !field.enum.includes(field.default)) fail(directory, path + '.default', 'does not match a non-secret field');
    }
  }
  return value;
}

/** Validate data before reading or importing any executable plugin entry. */
export function validatePluginDeclaration(input, directory) {
  keys(input, ['kind', 'id', 'name', 'description', 'version', 'apiVersion', 'entries', 'capabilities', 'commands', 'resourceTypes', 'configSchema'], directory, 'manifest');
  if (input.kind !== 'nekodock-plugin') fail(directory, 'kind', 'must be nekodock-plugin');
  if (typeof input.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.id) || input.id.length > 80) fail(directory, 'id', 'must use lowercase words separated by hyphens');
  if (input.id !== directory) fail(directory, 'id', 'must match its directory name');
  text(input.name, directory, 'name', 160);
  if (input.description !== undefined) text(input.description, directory, 'description');
  if (typeof input.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(input.version) || input.version.length > 100) fail(directory, 'version', 'must be a semantic version');
  if (input.apiVersion !== 1) fail(directory, 'apiVersion', 'is unsupported');
  keys(input.entries, ['console', 'runner'], directory, 'entries');
  for (const [name, entry] of Object.entries(input.entries)) {
    if (typeof entry !== 'string' || !/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/u.test(entry)) fail(directory, 'entries.' + name, 'must reference a local JavaScript entry');
  }
  if (!input.entries.console) fail(directory, 'entries.console', 'is required');
  const declaredCapabilities = list(input.capabilities, capabilities, directory, 'capabilities');
  const commands = input.commands === undefined ? [] : input.commands;
  if (!Array.isArray(commands) || commands.length > 100) fail(directory, 'commands', 'must be an array with at most 100 commands');
  const seenCommands = new Set();
  for (const command of commands) {
    keys(command, ['name', 'description', 'contextPolicy', 'executor'], directory, 'commands');
    if (typeof command.name !== 'string' || !/^\/[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/u.test(command.name) || command.name.length > 100) fail(directory, 'commands.name', 'must be a slash command');
    if (seenCommands.has(command.name)) fail(directory, 'commands.name', 'is duplicated');
    seenCommands.add(command.name);
    text(command.description, directory, 'commands.description');
    if (!['control', 'chat'].includes(command.contextPolicy)) fail(directory, 'commands.contextPolicy', 'is unsupported');
    if (!['worker', 'console'].includes(command.executor)) fail(directory, 'commands.executor', 'is unsupported');
    const core = input.id === 'core';
    if (command.executor !== (core ? 'worker' : 'console') || command.contextPolicy !== (core ? 'control' : 'chat')) fail(directory, 'commands', core ? 'must use worker/control routing' : 'must use console/chat routing');
  }
  if (commands.length && !declaredCapabilities.includes('commands')) fail(directory, 'commands', 'require the commands capability');
  if (input.id !== 'core' && !declaredCapabilities.some(capability => capability === 'content-enrichment' || capability === 'video-download')) fail(directory, 'capabilities', 'API version 1 requires non-core plugins to declare content-enrichment or video-download');
  if (declaredCapabilities.some(capability => capability !== 'commands') && !input.entries.runner) fail(directory, 'entries.runner', 'is required for content or download execution');
  if (input.id === 'core' && (input.entries.runner || declaredCapabilities.length !== 1 || declaredCapabilities[0] !== 'commands')) fail(directory, 'core', 'must be a command-only plugin');
  return {
    ...input,
    commands,
    resourceTypes: input.resourceTypes === undefined ? [] : list(input.resourceTypes, resourceTypes, directory, 'resourceTypes'),
    ...(input.configSchema === undefined ? {} : { configSchema: configSchema(input.configSchema, directory) }),
  };
}

export async function discoverPlugins(pluginsDir) {
  const root = await realpath(pluginsDir);
  const plugins = [];
  const ids = new Set(), commands = new Set();
  const directories = await readdir(root, { withFileTypes: true });
  for (const child of directories.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue;
    const directory = resolve(root, child.name), declaration = resolve(directory, 'nekodock.plugin.json');
    let file;
    try { file = await lstat(declaration); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    if (child.isSymbolicLink()) fail(child.name, 'directory', 'must not be a symbolic link');
    if (!file.isFile() || file.isSymbolicLink() || file.size > 256 * 1024) fail(child.name, 'manifest', 'must be a regular file no larger than 256 KiB');
    let raw;
    try { raw = JSON.parse(await readFile(declaration, 'utf8')); } catch { fail(child.name, 'manifest', 'must contain valid JSON'); }
    if (ids.has(raw?.id)) fail(child.name, 'id', 'is duplicated');
    const manifest = validatePluginDeclaration(raw, child.name);
    ids.add(manifest.id);
    for (const command of manifest.commands) {
      if (commands.has(command.name)) fail(child.name, 'commands.name', 'conflicts with another plugin');
      commands.add(command.name);
    }
    const directoryRealPath = await realpath(directory);
    const entries = {};
    for (const [runtime, declared] of Object.entries(manifest.entries)) {
      const source = resolve(directory, declared.replace(/\.js$/u, '.ts'));
      let sourceRealPath;
      try { sourceRealPath = await realpath(source); } catch { fail(child.name, 'entries.' + runtime, 'has no TypeScript source'); }
      if (!contained(directoryRealPath, sourceRealPath) || !(await stat(sourceRealPath)).isFile()) fail(child.name, 'entries.' + runtime, 'must stay inside the plugin directory');
      entries[runtime] = source;
    }
    plugins.push({ directory, manifest, entries });
  }
  if (!ids.has('core')) throw new Error('Missing required core plugin declaration');
  return plugins.sort((a, b) => a.manifest.id === 'core' ? -1 : b.manifest.id === 'core' ? 1 : a.manifest.id.localeCompare(b.manifest.id, 'en'));
}

export function publicPluginManifest(declaration) {
  const { kind: _kind, entries: _entries, ...manifest } = declaration;
  return {
    ...manifest,
    required: manifest.id === 'core',
    commands: manifest.commands.map(command => ({ ...command, pluginId: manifest.id })),
    fields: Object.entries(manifest.configSchema?.properties ?? {}).map(([key, field]) => ({
      key, label: field.title, type: field.enum ? 'select' : field.secret ? 'secret' : field.type === 'integer' ? 'number' : field.type,
      ...(field.description === undefined ? {} : { description: field.description }),
      ...(field.minimum === undefined ? {} : { min: field.minimum }),
      ...(field.maximum === undefined ? {} : { max: field.maximum }),
      ...(field.default === undefined ? {} : { default: field.default }),
      ...(field.enum === undefined ? {} : { options: field.enum.map((value, index) => ({ value, label: field.enumLabels?.[index] ?? value })) }),
      ...(field.group === undefined ? {} : { group: field.group }),
    })),
  };
}

export function moduleSpecifier(outputDir, source) {
  const path = relative(outputDir, source).split(sep).join('/').replace(/\.ts$/u, '.js');
  return path.startsWith('.') ? path : './' + path;
}
