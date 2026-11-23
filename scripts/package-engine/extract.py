"""Build-only stdlib extraction; no archive-controlled paths reach extractall."""
import gzip
import json
import os
import posixpath
import re
import stat
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Any


def portable(name):
    if not isinstance(name, str) or len(name) > 4096 or re.search(r'[\\:;*?"<>|\x00-\x1f\x7f]', name):
        raise ValueError('archive unsafe path')
    parts = name.split('/')
    for part in parts:
        if not part or part in ('.', '..') or part.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', part, re.I):
            raise ValueError('archive unsafe component')
    return name


def zip_name(entry):
    # ZipInfo.filename is sanitized (notably NUL-truncated). Validate the
    # original decoded header name before any directory/filter/path decision.
    original = entry.orig_filename
    portable(original[:-1] if original.endswith('/') else original)
    if original != entry.filename:
        raise ValueError('archive ZIP name mismatch')
    return original


def extract(source, out, opt):
    source, output = Path(source), Path(out)
    if not source.is_absolute() or source.is_symlink() or not source.is_file() or source.stat().st_nlink != 1 or source.stat().st_size > opt.get('maxArchiveBytes', 512 * 1024 * 1024):
        raise ValueError('archive unsafe source/size limit')
    if not output.is_absolute() or str(output) != out or output.exists() or output.is_symlink():
        raise ValueError('archive unsafe output')
    for parent in (output.parent, *output.parents):
        if parent.is_symlink() or not parent.is_dir():
            raise ValueError('archive unsafe output parent')
    limit = opt.get('maxExpandedBytes', 768 * 1024 * 1024)
    max_file = opt.get('maxFileBytes', 192 * 1024 * 1024)
    max_entries = opt.get('maxEntries', 12000)
    root = portable(opt['root'])
    if '/' in root:
        raise ValueError('archive invalid root')
    entries = {}
    aliases = {}
    total = 0
    archive: Any = None
    iterator: Any
    try:
        if opt['kind'] == 'tar':
            # Consume the gzip footer too: tar end markers alone do not detect a
            # truncated gzip stream. Bound the decompressed stream incl padding.
            with open(source, 'rb') as f:
                gz = f.read(2) == b'\x1f\x8b'
            size, tail = 0, b''
            binary_stream: Any = gzip.open(source, 'rb') if gz else open(source, 'rb')
            with binary_stream as f:
                while chunk := f.read(1024 * 1024):
                    size += len(chunk)
                    tail = (tail + chunk)[-1024:]
                    if size > limit + max_entries * 4096:
                        raise ValueError('archive expanded stream limit')
            if size < 1024 or size % 512 or tail != b'\0' * 1024:
                raise ValueError('archive truncated tar terminator')
            archive = tarfile.open(source, 'r:*')
            iterator = iter(archive)
        elif opt['kind'] == 'zip':
            archive = zipfile.ZipFile(source)
            iterator = iter(archive.infolist())
        else:
            raise ValueError('archive kind')
        for i, entry in enumerate(iterator):
            if i >= max_entries:
                raise ValueError('archive entry limit')
            is_zip = opt['kind'] == 'zip'
            raw = zip_name(entry) if is_zip else entry.name
            directory = raw.endswith('/') if is_zip else entry.isdir()
            name = portable(raw[:-1] if directory and raw.endswith('/') else raw)
            if name != root and not name.startswith(root + '/'):
                raise ValueError('archive unexpected root')
            if name in entries:
                raise ValueError('archive duplicate alias')
            prefix = ''
            for part in name.split('/'):
                prefix += ('/' if prefix else '') + part
                lower = prefix.lower()
                if lower in aliases and aliases[lower] != prefix:
                    raise ValueError('archive case alias')
                aliases[lower] = prefix
            if is_zip:
                mode = entry.external_attr >> 16
                if entry.flag_bits & 1 or stat.S_IFMT(mode) not in (0, stat.S_IFDIR, stat.S_IFREG):
                    raise ValueError('archive special zip type')
                kind = 'dir' if directory else 'file'
                size = entry.file_size
            else:
                mode = entry.mode
                if entry.issym():
                    kind = 'link'
                elif directory:
                    kind = 'dir'
                elif entry.isfile() and not entry.islnk():
                    kind = 'file'
                else:
                    raise ValueError('archive special/hardlink type')
                size = entry.size
            # Official Windows ZIP directories have SGID metadata from their
            # build host. Directory modes are never copied; create private 0700.
            if (kind != 'dir' and mode & 0o6000) or size < 0 or size > max_file:
                raise ValueError('archive file/mode limit')
            total += size
            if total > limit:
                raise ValueError('archive expanded size limit')
            entries[name] = (kind, entry, size, mode)
        for name in entries:
            parent = posixpath.dirname(name)
            while parent:
                if parent in entries and entries[parent][0] != 'dir':
                    raise ValueError('archive non-directory ancestor')
                parent = posixpath.dirname(parent)

        def resolve(name, seen):
            if name in seen or name not in entries:
                raise ValueError('archive link cycle/unknown target')
            kind, entry, size, mode = entries[name]
            if kind == 'link':
                if not opt.get('runtimeLegalLinks') or not name.startswith(root + '/legal/'):
                    raise ValueError('archive unapproved symlink')
                target = entry.linkname
                if not target or target.startswith('/') or re.search(r'[\\:\x00-\x1f]', target):
                    raise ValueError('archive unsafe symlink')
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
                portable(target)
                if not target.startswith(root + '/legal/'):
                    raise ValueError('archive escaping symlink')
                return resolve(target, seen | {name})
            if kind != 'file':
                raise ValueError('archive nonregular link target')
            return entry, size, mode

        resolved = {}
        for name, (kind, entry, size, mode) in entries.items():
            if kind != 'dir':
                resolved[name] = resolve(name, set())
        if sum(v[1] for v in resolved.values()) > limit:
            raise ValueError('archive dereferenced size limit')
        out = Path(out)
        out.mkdir(mode=0o700)  # caller supplies a NEW private staging child
        for name, (kind, entry, size, mode) in entries.items():
            if name == root:
                continue
            target = out / name[len(root) + 1:]
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if kind == 'dir':
                target.mkdir(exist_ok=True, mode=0o700)
                continue
            entry, size, mode = resolved[name]
            stream = archive.open(entry) if opt['kind'] == 'zip' else archive.extractfile(entry)
            with stream, target.open('xb') as dest:
                remaining = size
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('archive truncated file')
                    dest.write(chunk)
                    remaining -= len(chunk)
                if stream.read(1):
                    raise ValueError('archive file size mismatch')
            target.chmod(0o700 if mode & 0o111 else 0o600)
            os.utime(target, (0, 0))
    finally:
        if archive:
            archive.close()


def notices(source, out):
    result = []
    out = Path(out)
    with zipfile.ZipFile(source) as archive:
        if len(archive.infolist()) > 100000:
            raise ValueError('archive jar entry limit')
        # Validate all original names before creating/copying any notice output.
        entries = [(entry, zip_name(entry)) for entry in archive.infolist()]
        out.mkdir(mode=0o700)
        total = 0
        for entry, name in entries:
            base = name.rsplit('/', 1)[-1]
            if name.endswith('/') or not re.match(r'^(license|notice|copying|copyright)([._-]|$)', base, re.I) or name.endswith('.class'):
                continue
            portable(name)
            total += entry.file_size
            if entry.file_size > 4 * 1024 * 1024 or total > 16 * 1024 * 1024:
                raise ValueError('archive notice limit')
            data = archive.read(entry)
            dest = str(len(result)).zfill(3) + '.txt'
            (out / dest).write_bytes(data)
            result.append({'entry': name, 'file': dest})
    (out / 'entries.json').write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'extract':
            extract(sys.argv[2], sys.argv[3], json.loads(sys.argv[4]))
        elif sys.argv[1] == 'notices':
            notices(sys.argv[2], sys.argv[3])
        else:
            raise ValueError('archive command')
    except Exception as error:
        print('archive rejected: ' + str(error), file=sys.stderr)
        sys.exit(1)
