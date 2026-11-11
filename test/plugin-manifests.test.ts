import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { generatePluginRegistries } = await import(pathToFileURL(resolve('scripts/generate-plugins.mjs')).href);
const { discoverPlugins } = await import(pathToFileURL(resolve('scripts/lib/plugin-manifests.mjs')).href);

const declaration = (id: string, patch: Record<string, unknown> = {}) => ({
  kind: 'nekodock-plugin', id, name: 'Synthetic ' + id, version: '1.2.3', apiVersion: 1,
  entries: id === 'core' ? { console: './index.js' } : { console: './index.js', runner: './runner.js' },
  capabilities: id === 'core' ? ['commands'] : ['commands', 'content-enrichment'], resourceTypes: [],
  commands: [{ name: '/' + id, description: 'Synthetic command.', contextPolicy: id === 'core' ? 'control' : 'chat', executor: id === 'core' ? 'worker' : 'console' }], ...patch,
});

async function addPlugin(root: string, id: string, patch: Record<string, unknown> = {}) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'nekodock.plugin.json'), JSON.stringify(declaration(id, patch)));
  // Discovery must never execute this file.
  await writeFile(join(directory, 'index.ts'), 'throw new Error("Synthetic entry was executed during discovery");\n');
  if (id !== 'core') await writeFile(join(directory, 'runner.ts'), 'throw new Error("Synthetic runner was executed during discovery");\n');
  return directory;
}

async function fixture(t: TestContext, core = true) {
  const directory = await mkdtemp(join(tmpdir(), 'nekodock-plugin-manifests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'plugins'), outputDir = join(directory, 'generated');
  await mkdir(root);
  if (core) await addPlugin(root, 'core');
  return { directory, root, outputDir, generate: () => generatePluginRegistries({ pluginsDir: root, outputDir }) };
}

test('plugin discovery ignores unrelated files and unmarked directories without importing entry code', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'notes.txt'), 'Synthetic notes.');
  await mkdir(join(f.root, 'scratch', 'nested'), { recursive: true });
  await addPlugin(join(f.root, 'scratch'), 'nested');
  await addPlugin(f.root, 'example');
  const result = await f.generate();
  assert.deepEqual(result.plugins, ['core', 'example']);
  const catalog = await readFile(join(f.outputDir, 'catalog.ts'), 'utf8');
  assert.match(catalog, /"id": "core"[\s\S]*?"required": true/u);
  assert.match(catalog, /"id": "example"[\s\S]*?"required": false/u);
  assert.doesNotMatch(catalog, /nested/u);
  assert.match(await readFile(join(f.outputDir, 'console.ts'), 'utf8'), /createPlugin1\(pluginManifests\[1\]!\)/u);
});

test('forward inspection declarations are Console-only and cannot mix platform or command execution', async t => {
  const f = await fixture(t);
  const directory = await addPlugin(f.root, 'vision-check', {entries: {console: './index.js'}, capabilities: ['forward-inspection'], commands: [], resourceTypes: []});
  assert.deepEqual((await f.generate()).plugins, ['core', 'vision-check']);
  assert.doesNotMatch(await readFile(join(f.outputDir, 'runner.ts'), 'utf8'), /vision-check/u);
  for (const patch of [
    {entries: {console: './index.js', runner: './runner.js'}},
    {capabilities: ['forward-inspection', 'content-enrichment']},
    {resourceTypes: ['video']},
    {commands: [{name: '/inspect', description: 'Synthetic', executor: 'console', contextPolicy: 'chat'}]},
  ]) {
    await writeFile(join(directory, 'nekodock.plugin.json'), JSON.stringify(declaration('vision-check', {
      entries: {console: './index.js'}, capabilities: ['forward-inspection'], commands: [], resourceTypes: [], ...patch,
    })));
    await assert.rejects(f.generate());
  }
});

test('adding and removing a declared plugin regenerates separate Console and Runner registries', async t => {
  const f = await fixture(t);
  await f.generate();
  const plugin = await addPlugin(f.root, 'example', {
    entries: { console: './index.js', runner: './runner.js' }, capabilities: ['commands', 'content-enrichment'], resourceTypes: ['post'],
    configSchema: { type: 'object', properties: {
      enabled: { type: 'boolean', title: 'Synthetic enabled', default: true },
      count: { type: 'integer', title: 'Synthetic count', minimum: 1, maximum: 8, default: 2 },
      token: { type: 'string', title: 'Synthetic token', secret: true },
    } },
  });
  await writeFile(join(plugin, 'runner.ts'), 'export const runnerDefinition = {};\n');
  assert.deepEqual((await f.generate()).plugins, ['core', 'example']);
  const runner = await readFile(join(f.outputDir, 'runner.ts'), 'utf8');
  const catalog = await readFile(join(f.outputDir, 'catalog.ts'), 'utf8');
  assert.match(runner, /example\/runner\.js/u);
  assert.doesNotMatch(runner, /core\/index|example\/index/u);
  assert.match(catalog, /"pluginId": "example"/u);
  assert.match(catalog, /"type": "secret"/u);
  assert.match(catalog, /"min": 1/u);
  assert.doesNotMatch(catalog, /"entries"|"kind"/u);
  await rm(plugin, { recursive: true });
  await f.generate();
  assert.doesNotMatch(await readFile(join(f.outputDir, 'runner.ts'), 'utf8'), /example/u);
  assert.doesNotMatch(await readFile(join(f.outputDir, 'console.ts'), 'utf8'), /example/u);
});

test('plugin declaration rejects malformed metadata, unsupported API and self-selected required policy', async t => {
  const invalid: Array<Record<string, unknown>> = [
    { kind: 'ordinary-directory' }, { apiVersion: 2 }, { id: 'different-directory' }, { id: '../escape' },
    { id: 'UpperCase' }, { version: 'not-a-version' }, { required: true }, { required: false },
    { entries: { console: './index.js', unsupported: './index.js' } },
    { capabilities: ['unknown-feature'] }, { capabilities: ['commands', 'commands'] },
    { commands: [{ name: '/example', pluginId: 'core', description: 'Synthetic.', contextPolicy: 'chat', executor: 'console' }] },
  ];
  for (const patch of invalid) {
    const f = await fixture(t);
    await addPlugin(f.root, 'example', patch);
    await assert.rejects(f.generate, /Invalid plugin declaration/u);
  }
  const f = await fixture(t);
  const plugin = await addPlugin(f.root, 'example');
  await writeFile(join(plugin, 'nekodock.plugin.json'), '{invalid');
  await assert.rejects(f.generate, /valid JSON/u);
});

test('missing or invalid core declaration fails the build and optional plugins cannot impersonate it', async t => {
  const f = await fixture(t, false);
  await addPlugin(f.root, 'example');
  await assert.rejects(f.generate, /Missing required core/u);
  await addPlugin(f.root, 'core', { capabilities: ['commands', 'content-enrichment'], entries: { console: './index.js', runner: './runner.js' } });
  await assert.rejects(f.generate, /command-only/u);
  await addPlugin(f.root, 'core');
  await addPlugin(f.root, 'example', { id: 'core' });
  await assert.rejects(f.generate, /duplicated/u);
});

test('duplicate commands across plugins are rejected before registry generation', async t => {
  const f = await fixture(t);
  await addPlugin(f.root, 'example', { commands: declaration('core').commands.map(command => ({ ...command, contextPolicy: 'chat', executor: 'console' })) });
  await assert.rejects(f.generate, /conflicts with another plugin/u);
});

test('command declarations use the runtime and context policy supported by their plugin kind', async t => {
  for (const id of ['core', 'example']) {
    const expected = id === 'core' ? 'worker/control' : 'console/chat';
    for (const wrong of id === 'core' ? [{ executor: 'console' }, { contextPolicy: 'chat' }] : [{ executor: 'worker' }, { contextPolicy: 'control' }]) {
      const f = await fixture(t);
      await addPlugin(f.root, id, { commands: declaration(id).commands.map(command => ({ ...command, ...wrong })) });
      await assert.rejects(f.generate, new RegExp(expected, 'u'));
    }
  }
});

test('API version one accepts optional Console command plugins without creating Runner entries', async t => {
  const command = await fixture(t);
  await addPlugin(command.root, 'example', { entries: { console: './index.js' }, capabilities: ['commands'] });
  assert.deepEqual((await command.generate()).plugins, ['core', 'example']);
  assert.match(await readFile(join(command.outputDir, 'console.ts'), 'utf8'), /example\/index\.js/u);
  assert.doesNotMatch(await readFile(join(command.outputDir, 'runner.ts'), 'utf8'), /example/u);
  const runner = await fixture(t);
  await addPlugin(runner.root, 'example', { capabilities: ['commands'] });
  await assert.rejects(runner.generate, /command-only plugin executes in the Console/u);
  const empty = await fixture(t);
  await addPlugin(empty.root, 'example', { entries: { console: './index.js' }, capabilities: ['commands'], commands: [] });
  await assert.rejects(empty.generate, /must declare at least one command/u);
  const f = await fixture(t);
  await addPlugin(f.root, 'example', { capabilities: ['content-enrichment'], commands: [] });
  assert.deepEqual((await f.generate()).plugins, ['core', 'example']);
});

test('plugin entries must exist, use local paths and stay inside their plugin directory', async t => {
  for (const entry of ['../index.js', '/tmp/index.js', './nested/../../index.js', './index.ts', 'https://example.invalid/index.js', './missing.js', './directory.js']) {
    const f = await fixture(t);
    const plugin = await addPlugin(f.root, 'example', { entries: { console: entry, runner: './runner.js' } });
    await mkdir(join(plugin, 'directory.ts'));
    await assert.rejects(f.generate, /entries.console/u);
  }
  const missingRunner = await fixture(t);
  await addPlugin(missingRunner.root, 'example', { entries: { console: './index.js' }, capabilities: ['content-enrichment'], commands: [] });
  await assert.rejects(missingRunner.generate, /entries.runner/u);
});

test('manifest and entry symlinks cannot redirect discovery outside a plugin', async t => {
  const f = await fixture(t), plugin = await addPlugin(f.root, 'example');
  const outside = join(f.directory, 'outside.ts');
  await writeFile(outside, 'export default {}');
  await rm(join(plugin, 'index.ts'));
  await symlink(outside, join(plugin, 'index.ts'));
  await assert.rejects(f.generate, /stay inside/u);
  await rm(join(plugin, 'index.ts'));
  await writeFile(join(plugin, 'index.ts'), 'export default {}');
  const manifest = join(plugin, 'nekodock.plugin.json'), outsideManifest = join(f.directory, 'outside.json');
  await writeFile(outsideManifest, JSON.stringify(declaration('example')));
  await rm(manifest);
  await symlink(outsideManifest, manifest);
  await assert.rejects(f.generate, /regular file/u);
  await rm(plugin, { recursive: true });
  const other = await addPlugin(f.directory, 'example');
  await symlink(other, join(f.root, 'example'));
  await assert.rejects(f.generate, /symbolic link/u);
});

test('configuration schema enforces field types, ranges and credential defaults', async t => {
  for (const field of [
    { type: 'boolean', title: 'Synthetic', default: 'true' },
    { type: 'integer', title: 'Synthetic', minimum: 3, maximum: 1 },
    { type: 'integer', title: 'Synthetic', minimum: 1, default: 0 },
    { type: 'integer', title: 'Synthetic', default: 1.5 },
    { type: 'string', title: 'Synthetic', secret: true, default: 'synthetic-token' },
    { type: 'boolean', title: 'Synthetic', secret: true },
    { type: 'string', title: 'Synthetic', enum: [] },
    { type: 'string', title: 'Synthetic', enum: ['off', 'off'] },
    { type: 'string', title: 'Synthetic', enum: ['off', 1] },
    { type: 'boolean', title: 'Synthetic', enum: ['off', 'on'] },
    { type: 'string', title: 'Synthetic', secret: true, enum: ['off', 'on'] },
    { type: 'string', title: 'Synthetic', enum: ['off', 'on'], default: 'unsupported' },
    { type: 'string', title: 'Synthetic', enum: ['off', 'on'], enumLabels: ['One'] },
    { type: 'string', title: 'Synthetic', enumLabels: ['One'] },
    { type: 'string', title: 'Synthetic', enum: ['off'], enumLabels: [''] },
    { type: 'string', title: 'Synthetic', group: '' },
  ]) {
    const f = await fixture(t);
    await addPlugin(f.root, 'example', { configSchema: { type: 'object', properties: { example: field } } });
    await assert.rejects(f.generate, /configSchema/u);
  }
});

test('enum fields generate grouped select options and live resources retain their declaration', async t => {
  const f = await fixture(t);
  await addPlugin(f.root, 'example', { resourceTypes: ['post', 'live'], configSchema: { type: 'object', properties: {
    display: { type: 'string', title: 'Display', enum: ['off', 'original', 'card'], enumLabels: ['Closed', 'Original', 'Card'], default: 'off', group: 'Presentation' },
    raw: { type: 'string', title: 'Raw', enum: ['one', 'two'] },
  } } });
  await f.generate();
  const source = await readFile(join(f.outputDir, 'catalog.ts'), 'utf8');
  const manifests = JSON.parse(source.slice(source.indexOf('= [') + 2).replace(/;\s*$/u, ''));
  const plugin = manifests.find((item: {id:string}) => item.id === 'example');
  assert.deepEqual(plugin.resourceTypes, ['post', 'live']);
  assert.deepEqual(plugin.fields[0], {key:'display',label:'Display',type:'select',default:'off',options:[{value:'off',label:'Closed'},{value:'original',label:'Original'},{value:'card',label:'Card'}],group:'Presentation'});
  assert.deepEqual(plugin.fields[1].options,[{value:'one',label:'one'},{value:'two',label:'two'}]);
});

test('registry output is deterministic and does not rewrite unchanged generated files', async t => {
  const f = await fixture(t);
  await addPlugin(f.root, 'zeta');
  await addPlugin(f.root, 'alpha');
  assert.deepEqual((await discoverPlugins(f.root)).map((plugin: { manifest: { id: string } }) => plugin.manifest.id), ['core', 'alpha', 'zeta']);
  await f.generate();
  const paths = ['catalog.ts', 'console.ts', 'runner.ts'].map(name => join(f.outputDir, name));
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await Promise.all(paths.map(path => utimes(path, new Date(1000), new Date(1000))));
  await f.generate();
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
  assert.deepEqual(await Promise.all(paths.map(async path => (await stat(path)).mtimeMs)), [1000, 1000, 1000]);
});

test('configuration parents group child fields under boolean or enum controls without changing defaults', async t => {
  const f = await fixture(t);
  await addPlugin(f.root, 'example', { configSchema: { type: 'object', properties: {
    detail: { type: 'boolean', title: 'Detail', default: true, group: 'Presentation', parent: 'autoCard' },
    autoCard: { type: 'boolean', title: 'Card', default: false, group: 'Presentation' },
    mode: { type: 'string', title: 'Mode', enum: ['off', 'card'], default: 'off' },
    count: { type: 'integer', title: 'Count', minimum: 1, maximum: 4, default: 2, parent: 'mode' },
  } } });
  await f.generate();
  const source = await readFile(join(f.outputDir, 'catalog.ts'), 'utf8');
  const manifests = JSON.parse(source.slice(source.indexOf('= [') + 2).replace(/;\s*$/u, ''));
  const plugin = manifests.find((item: { id: string }) => item.id === 'example');
  assert.deepEqual(plugin.configSchema.properties.detail, { type: 'boolean', title: 'Detail', default: true, group: 'Presentation', parent: 'autoCard' });
  assert.deepEqual(plugin.fields[0], { key: 'detail', label: 'Detail', type: 'boolean', default: true, group: 'Presentation', parent: 'autoCard' });
  assert.equal(plugin.fields[1].parent, undefined);
  assert.deepEqual(plugin.fields[3], { key: 'count', label: 'Count', type: 'number', min: 1, max: 4, default: 2, parent: 'mode' });
  assert.equal(plugin.configSchema.properties.autoCard.default, false, 'Visual grouping does not force an enabling value');
});

test('configuration parents reject missing references, incompatible groups and nested or cyclic ownership', async t => {
  const control = { type: 'boolean', title: 'Control', default: false, group: 'Behavior' };
  const child = { type: 'boolean', title: 'Detail', default: true, group: 'Behavior', parent: 'control' };
  const invalid = [
    { control, detail: { ...child, parent: '' } },
    { control, detail: { ...child, parent: 1 } },
    { control, detail: { ...child, parent: 'missing' } },
    { control, detail: { ...child, parent: 'toString' } },
    { control, detail: { ...child, parent: 'detail' } },
    { control, detail: { ...child, group: 'Other' } },
    { control, detail: { ...child, group: undefined } },
    { control: { type: 'integer', title: 'Count', default: 1, group: 'Behavior' }, detail: child },
    { control: { type: 'string', title: 'Text', group: 'Behavior' }, detail: child },
    { control: { type: 'string', title: 'Secret', secret: true, group: 'Behavior' }, detail: child },
    { control, detail: child, nested: { ...child, parent: 'detail' } },
    { control: { ...control, parent: 'detail' }, detail: child },
  ];
  for (const properties of invalid) {
    const f = await fixture(t);
    await addPlugin(f.root, 'example', { configSchema: { type: 'object', properties } });
    await assert.rejects(f.generate, /configSchema\.properties\.[A-Za-z]+\.parent/u);
  }
});

test('content plugins keep response abilities independent and declare only game-card price ownership', async () => {
  const plugins = await discoverPlugins(resolve('src/plugins'));
  for (const id of ['bilibili', 'douyin']) {
    const plugin = plugins.find((item: { manifest: { id: string } }) => item.manifest.id === id);
    const fields = plugin.manifest.configSchema.properties;
    assert.deepEqual(Object.keys(fields).slice(0, 3), ['enhance', 'videoDisplay', 'autoVideo']);
    for (const key of ['enhance', 'videoDisplay', 'autoVideo']) {
      assert.equal(fields[key].group, '视频行为');
      assert.equal(fields[key].parent, undefined);
    }
    assert.equal(fields.maxMiB.group, '媒体与缓存');
    assert.equal(fields.maxMiB.parent, undefined);
    assert.equal(fields.maxDurationSeconds.group, '视频下载限制');
    assert.equal(fields.timeoutSeconds.group, '处理');
  }
  const heybox = plugins.find((item: { manifest: { id: string } }) => item.manifest.id === 'heybox').manifest.configSchema.properties;
  assert.equal(heybox.enhance.parent, undefined);
  assert.equal(heybox.autoCard.parent, undefined);
  assert.equal(heybox.showPrices.parent, 'autoCard');
  assert.equal(heybox.showPrices.group, heybox.autoCard.group);
  const children = plugins.flatMap((plugin: { manifest: { id: string; configSchema?: { properties: Record<string, { parent?: string }> } } }) =>
    Object.entries(plugin.manifest.configSchema?.properties ?? {}).flatMap(([key, field]) => field.parent ? [`${plugin.manifest.id}.${key}`] : []));
  assert.deepEqual(children, ['heybox.showPrices']);
});
