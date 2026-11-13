'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Versi harus memakai MAJOR.MINOR.PATCH tanpa awalan V atau prerelease.');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Angka versi terlalu besar.');
  return parts;
}

function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (!action || extra.length) throw new Error('Gunakan --check, patch, minor, major, atau versi X.Y.Z.');
  const versionFile = path.join(root, 'VERSION');
  const packageFile = path.join(root, 'package.json');
  const apiFile = path.join(root, 'openapi.yaml');
  const current = fs.readFileSync(versionFile, 'utf8').trim();
  const parts = parseVersion(current);
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  parseVersion(pkg.version);
  const api = fs.readFileSync(apiFile, 'utf8');
  const info = api.match(/^info:[ \t]*\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)*/m);
  const entries = info ? [...info[0].matchAll(/^ {2}version:[ \t]*([^\r\n]+)$/gm)] : [];
  if (entries.length !== 1) throw new Error('openapi.yaml harus memiliki satu info.version.');
  const apiVersion = entries[0][1].trim();
  parseVersion(apiVersion);
  if (action === '--check') {
    if (pkg.version !== current || apiVersion !== current) {
      throw new Error(`Versi tidak sinkron: VERSION=${current}, package.json=${pkg.version}, OpenAPI=${apiVersion}.`);
    }
    console.log(`Versi sinkron: ${current} (tag V${current})`);
    return;
  }
  const index = ['major', 'minor', 'patch'].indexOf(action);
  let next = action;
  if (index !== -1) {
    parts[index]++;
    for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
    next = parts.join('.');
  }
  const nextParts = parseVersion(next), currentParts = parseVersion(current);
  const difference = nextParts.findIndex((value, i) => value !== currentParts[i]);
  if (difference !== -1 && nextParts[difference] < currentParts[difference]) throw new Error('Versi tidak boleh diturunkan.');
  pkg.version = next;
  const updatedInfo = info[0].replace(/^( {2}version:[ \t]*)[^\r\n]+$/m, (_, prefix) => prefix + next);
  const updatedApi = api.slice(0, info.index) + updatedInfo + api.slice(info.index + info[0].length);
  const updatedPackage = JSON.stringify(pkg, null, 2) + '\n';
  // Validate all metadata before writing any file. Git operations stay explicit.
  fs.writeFileSync(versionFile, next + '\n');
  fs.writeFileSync(packageFile, updatedPackage);
  fs.writeFileSync(apiFile, updatedApi);
  console.log(`Versi diperbarui: ${current} → ${next}. Tag release: V${next}`);
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
