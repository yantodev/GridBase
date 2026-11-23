'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { failure } = require('./errors');
function assertSupportedPlatform(platform = process.platform) {
  if (platform === 'win32') throw failure('WINDOWS_PRIVATE_STORAGE_UNSUPPORTED');
  if (platform !== 'linux') throw failure('PRIVATE_PATH');
}
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs; }
async function checkComponents(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target || target.includes('\0')) throw failure('PRIVATE_PATH');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const st = await fs.lstat(current);
    if (st.isSymbolicLink() || (!st.isDirectory() && current !== target)) throw failure('PRIVATE_PATH');
  }
}
async function checkPrivateAncestors(target) {
  await checkComponents(target);
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const st = await fs.lstat(current);
    const stickyRoot = st.uid === 0 && (st.mode & 0o1000);
    if (!st.isDirectory() || ![0, process.getuid()].includes(st.uid) || ((st.mode & 0o022) && !stickyRoot)) throw failure('PRIVATE_PATH');
  }
}
function privacy(st, directory = false) {
  if (!(directory ? st.isDirectory() : st.isFile()) || st.uid !== process.getuid() || (st.mode & 0o077) || (!directory && st.nlink !== 1)) throw failure('PRIVATE_PATH');
}
async function privateDirectory(target) {
  assertSupportedPlatform();
  try {
    await checkPrivateAncestors(path.dirname(target));
    try { await fs.mkdir(target, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await checkPrivateAncestors(target); const st = await fs.lstat(target); privacy(st, true);
    return target;
  } catch { throw failure('PRIVATE_PATH'); }
}
async function openRegular(target, { privateFile = false } = {}) {
  await checkComponents(target); const before = await fs.lstat(target);
  if (!before.isFile() || before.nlink !== 1) throw failure('PRIVATE_PATH');
  if (privateFile) { assertSupportedPlatform(); await checkPrivateAncestors(path.dirname(target)); privacy(before); privacy(await fs.lstat(path.dirname(target)), true); }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const st = await handle.stat(); if (!same(before, st) || !st.isFile() || st.nlink !== 1) throw failure('PRIVATE_PATH'); return { handle, st }; }
  catch (e) { await handle.close(); throw e; }
}
async function stable(target, handle, st) {
  await checkComponents(target); const after = await fs.lstat(target);
  if (!same(st, after) || !same(st, await handle.stat())) throw failure('PRIVATE_PATH');
}
async function readRegularFile(target, max, privateFile = false) {
  let opened;
  try {
    opened = await openRegular(target, { privateFile }); const { handle, st } = opened;
    if (st.size > max) throw failure('PRIVATE_PATH');
    const bytes = Buffer.alloc(st.size + 1); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== st.size) throw failure('PRIVATE_PATH'); await stable(target, handle, st); return bytes.subarray(0, offset);
  } catch { throw failure('PRIVATE_PATH'); } finally { if (opened) await opened.handle.close(); }
}
async function readPrivateFile(target, max) { return readRegularFile(target, max, true); }
async function exclusivePrivateFile(target, bytes) {
  assertSupportedPlatform(); await checkPrivateAncestors(path.dirname(target)); privacy(await fs.lstat(path.dirname(target)), true);
  let handle;
  try {
    handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    privacy(await handle.stat()); await handle.writeFile(bytes); await handle.sync();
    const st = await handle.stat(); await stable(target, handle, st);
  } finally { if (handle) await handle.close(); }
}
module.exports = { assertSupportedPlatform, privateDirectory, readPrivateFile, exclusivePrivateFile, checkComponents, readRegularFile, openRegular, stable, same };
