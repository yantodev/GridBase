const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gridbase-version-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    const script = path.resolve(__dirname, '../scripts/version.js');
    if (fs.existsSync(script)) fs.copyFileSync(script, path.join(root, 'scripts/version.js'));
    fs.writeFileSync(path.join(root, 'VERSION'), '1.2.3\n');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name: 'fixture', version: '1.2.3'}, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: Fixture API\n  version: 1.2.3\npaths: {}\n');
    run({root, command: value => spawnSync(process.execPath, [path.join(root, 'scripts/version.js'), value], {cwd: os.tmpdir(), encoding: 'utf8'}),
      contents: () => ['VERSION', 'package.json', 'openapi.yaml'].map(file => fs.readFileSync(path.join(root, file), 'utf8'))});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('version command checks synchronized metadata without rewriting files from a different cwd', () => {
  fixture(({command, contents}) => {
    const before = contents(), result = command('--check');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(contents(), before);
  });
});

test('patch, minor and major bumps synchronize metadata and preserve the OpenAPI specification version', () => {
  for (const [action, version] of [['patch', '1.2.4'], ['minor', '1.3.0'], ['major', '2.0.0'], ['3.4.5', '3.4.5']]) {
    fixture(({command, contents}) => {
      const result = command(action);
      assert.equal(result.status, 0, result.stderr);
      const [file, pkg, api] = contents();
      assert.equal(file, version + '\n'); assert.equal(JSON.parse(pkg).version, version);
      assert.ok(api.includes('  version: ' + version + '\n')); assert.ok(api.startsWith('openapi: 3.0.3\n'));
      assert.equal(command('--check').status, 0);
    });
  }
});

test('version drift is reported by check and a bump repairs metadata using VERSION as its source', () => {
  fixture(({root, command, contents}) => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","version":"0.9.0"}\n');
    const before = contents(), result = command('--check');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /tidak sinkron/i); assert.deepEqual(contents(), before);
    assert.equal(command('patch').status, 0);
    assert.equal(JSON.parse(contents()[1]).version, '1.2.4');
  });
});

test('invalid versions, unknown actions and downgrades fail without touching metadata', () => {
  for (const action of ['1.2', '01.2.3', '1.2.3-beta', 'V1.2.4', 'oops', 'toString', 'constructor', '__proto__', '1.2.2', '9007199254740992.0.0']) {
    fixture(({command, contents}) => {
      const before = contents(), result = command(action);
      assert.notEqual(result.status, 0, action); assert.deepEqual(contents(), before, action);
    });
  }
});

test('malformed OpenAPI metadata and missing version files are rejected before any writes', () => {
  fixture(({root, command, contents}) => {
    fs.writeFileSync(path.join(root, 'openapi.yaml'), 'openapi: 3.0.3\ninfo:\n  title: Missing version\npaths: {}\n');
    const before = contents(), result = command('patch');
    assert.notEqual(result.status, 0); assert.deepEqual(contents(), before);
    fs.unlinkSync(path.join(root, 'VERSION'));
    assert.notEqual(command('--check').status, 0);
  });
});
