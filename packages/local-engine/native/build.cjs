'use strict';
// Build-time only. Never imported by EngineClient and never compiles on startup.
const fs = require('node:fs/promises'); const path = require('node:path'); const { spawn } = require('node:child_process');
async function buildLauncher(output) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Native launcher build target is unsupported.');
  await fs.mkdir(path.dirname(output), { recursive: true });
  const args = ['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wformat=2','-fPIE','-pie','-fstack-protector-strong','-D_FORTIFY_SOURCE=2','-Wl,-z,relro,-z,now','-Wl,--build-id=none',path.join(__dirname, 'gridbase-launcher.c'),'-o',output];
  await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/cc', args, { env: { PATH: '/usr/bin:/bin', LANG: 'C', SOURCE_DATE_EPOCH: '0' }, stdio: ['ignore','ignore','pipe'] }); let errors = '';
    child.stderr.on('data', b => { if (errors.length < 16000) errors += b; }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Native launcher build failed: ' + errors)));
  }); await fs.chmod(output, 0o700); return output;
}
if (require.main === module) buildLauncher(process.argv[2]).then(() => console.log('Native launcher built.')).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildLauncher };
