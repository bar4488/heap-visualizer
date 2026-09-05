import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-stub.ts';

installDom();
const { setupCommands } = await import('../onboarding.ts');

test('install commands use the current host while heapviz remains host-independent', () => {
  const commands = setupCommands('https://viewer.example/tools/heap/?ignored=yes');
  assert.equal(commands.linuxInstall, 'curl -fsSL https://viewer.example/tools/heap/install.sh | HEAPVIZ_DOWNLOAD_BASE=https://viewer.example/tools/heap sh');
  assert.equal(commands.linuxOpen, 'heapviz open ~/path/to/trace-file');
  assert.equal(commands.linuxDemo, 'curl -fL https://viewer.example/tools/heap/demo.heapl -o heapviz-demo.heapl && heapviz open heapviz-demo.heapl');
  assert.equal(commands.windowsInstall, "$env:HEAPVIZ_DOWNLOAD_BASE='https://viewer.example/tools/heap'; irm https://viewer.example/tools/heap/install.ps1 | iex");
  assert.equal(commands.windowsOpen, 'heapviz open "C:\\path\\to\\trace-file"');
  assert.ok(commands.windowsDemo.includes('https://viewer.example/tools/heap/demo.heapl'));
});
