const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(c?js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
}
for (const directory of ['src', 'server', 'scripts', 'tests', 'e2e']) check(directory);
console.log('JavaScript syntax checks passed.');
