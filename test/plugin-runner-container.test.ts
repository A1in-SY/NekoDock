import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createConsole } from '../src/console/server.js';
import { DockerClient } from '../src/console/docker.js';

const image = process.env.PLUGIN_RUNNER_E2E_IMAGE;
const command = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  child.once('error', reject); child.once('close', code => resolve({ code, output }));
});

test('isolated plugin runner container creates and probes a real video and uploads it to Console', { skip: !image, timeout: 65000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-runner-container-'));
  const token = 'synthetic-container-runner-token';
  const app = await createConsole({ dataDir: join(root, 'console'), timers: false, staticDir: '/nonexistent', pluginRunnerToken: token,
    docker: new DockerClient({ socketPath: 'unused', image: 'unused', network: 'unused', consoleUrl: 'unused' }) });
  await app.app.listen({ host: '0.0.0.0', port: 0 });
  const port = (app.app.server.address() as AddressInfo).port;
  const name = `nekodock-plugin-e2e-${randomUUID()}`;
  const executable = join(root, 'yt-dlp');
  const script = `#!/usr/bin/env python3
import json,sys,subprocess
args=sys.argv[1:]
if '--dump-single-json' in args:
 print(json.dumps({'title':'Container video','webpage_url':'https://www.bilibili.com/video/BV1234567890','duration':1,'subtitles':{}}))
else:
 target=args[args.index('--output')+1]
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',target],check=True)
`;
  await writeFile(executable, script, { mode: 0o755 });
  const connection = app.db.createNapcatConnection({ name: 'Isolated', wsUrl: 'ws://127.0.0.1:9', mediaBaseUrl: `http://127.0.0.1:${port}` });
  const bot = app.db.createBot({ name: 'Example', targetType: 'group', targetId: '1001', connectionId: connection.id, config: {} });
  app.db.plugins.update(bot.id, 'bilibili', { expectedRevision: 0, enabled: true, config: { autoVideo: true } });
  app.db.setDesiredState(bot.id, 'running');
  app.db.enqueueNapcatEvent(bot.id, { post_type: 'message', message_type: 'group', group_id: '1001', user_id: '2001', self_id: '3001', message_id: 'share', time: 1,
    message: [{ type: 'text', data: { text: 'https://www.bilibili.com/video/BV1234567890' } }] }, 'synthetic-share');
  app.db.plugins.sync(bot.id, { bindings: [{ messageId: 'share', conversationId: 'conversation-one' }], conversationId: 'conversation-one' });
  const child = spawn('docker', ['run', '--rm', '--init', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
    '--mount', `type=bind,source=${executable},target=/usr/local/bin/yt-dlp,readonly`,
    '--env', `CONSOLE_URL=http://host.docker.internal:${port}`, '--env', `PLUGIN_RUNNER_TOKEN=${token}`, image!], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 45000; let result;
    while (Date.now() < deadline) {
      result = app.db.plugins.snapshot(bot.id).results.find(item => item.kind === 'video');
      if (result) break;
      if (child.exitCode !== null) assert.fail(`Runner stopped: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(result?.assetId, output);
    const media = app.db.pluginAssets.info(bot.id, result.assetId);
    assert.ok(media && media.size > 1000); assert.equal(media.mimeType, 'video/mp4');
    const url = app.db.pluginAssets.signedUrl(bot.id, result.assetId, `http://host.docker.internal:${port}`);
    const fetched = await command(['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', '--entrypoint', 'node', image!, '--input-type=module', '-e',
      `const response=await fetch(${JSON.stringify(url)},{headers:{range:'bytes=0-15'}});if(response.status!==206||(await response.arrayBuffer()).byteLength!==16)process.exit(1);`]);
    assert.equal(fetched.code, 0, fetched.output);
    assert.doesNotMatch(output, /synthetic-container-runner-token/);
  } finally {
    await command(['stop', '--time', '5', name]); await closed;
    await app.app.close(); await rm(root, { recursive: true, force: true });
  }
});
