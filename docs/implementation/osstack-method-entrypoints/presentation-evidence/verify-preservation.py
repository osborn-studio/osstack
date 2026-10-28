"""Read-only verification of the audit presentation against the original Git objects."""
from pathlib import Path
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[4]
directory = root / 'docs/implementation/osstack-method-entrypoints'
proof = json.loads((directory / 'audit-presentation.json').read_text())
rows = []
for row in proof['audits']:
    path = directory / row['path']
    presented = path.read_bytes()
    original = subprocess.run(['git', 'show', proof['original_commit'] + ':' + path.relative_to(root).as_posix()], cwd=root, capture_output=True, check=True).stdout
    offset, size = row['original_payload_offset_bytes'], row['original_bytes']
    if not (presented[offset:offset + size] == original and hashlib.sha256(original).hexdigest() == row['original_sha256'] and hashlib.sha256(presented).hexdigest() == row['presentation_sha256']):
        raise RuntimeError('audit payload or presentation changed: ' + row['path'])
    rows.append({'path': row['path'], 'original_payload_equal_git_bytes': True, 'original_sha256': row['original_sha256'], 'presentation_sha256': row['presentation_sha256']})
for name in ['evidence.tar.gz', 'evidence-manifest.json']:
    path = directory / name
    prior = subprocess.run(['git', 'show', proof['original_commit'] + ':' + path.relative_to(root).as_posix()], cwd=root, capture_output=True, check=True).stdout
    if prior != path.read_bytes():
        raise RuntimeError('historical archive changed: ' + name)
print(json.dumps({'status': 'passed', 'original_commit': proof['original_commit'], 'audits': rows, 'historical_archive_and_manifest_unchanged': True}, indent=2))
