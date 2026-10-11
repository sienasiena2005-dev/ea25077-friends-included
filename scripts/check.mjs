import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const folders = ['api', 'lib', 'scripts', 'public'];
let checked = 0;
for (const folder of folders) {
  for (const item of await fs.readdir(folder, { withFileTypes: true })) {
    if (!item.isFile() || !/\.(js|mjs)$/.test(item.name)) continue;
    const filename = path.join(folder, item.name);
    const check = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
    if (check.status !== 0) { console.error(check.stderr); process.exit(1); }
    checked++;
  }
}
console.log(`${checked} JavaScript files passed syntax checks.`);
