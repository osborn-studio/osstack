#!/usr/bin/env python3
"""Read-only manifest dependency probe. Emits JSON; does not invoke OSStack."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('repo', type=Path)
args = parser.parse_args()
packages = {}
for path in sorted((args.repo / 'packages').glob('*/package.json')):
    manifest = json.loads(path.read_text())
    packages[manifest['name']] = manifest
edges = set()
typed_edges = set()
for consumer, manifest in packages.items():
    for group in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
        for provider in manifest.get(group, {}):
            if provider in packages:
                edges.add((provider, consumer))
                typed_edges.add((provider, consumer, group))
edges = sorted(edges)

def affected(start, graph_edges=None):
    graph_edges = edges if graph_edges is None else graph_edges
    found = set()
    pending = [start]
    while pending:
        current = pending.pop()
        for provider, consumer in graph_edges:
            if provider == current and consumer not in found:
                found.add(consumer)
                pending.append(consumer)
    found.discard(start)
    return sorted(found)

print(json.dumps({
    'method': 'Declared workspace package dependencies; provider -> consumer; includes dependencies/dev/optional/peer; not symbol-level test selection',
    'nodes': sorted(packages),
    'edges': edges,
    'typed_edges': [{'provider': p, 'consumer': c, 'kind': k} for p, c, k in sorted(typed_edges)],
    'by_dependency_kind': {kind: {
        'edge_count': sum(k == kind for p, c, k in typed_edges),
        'impacted_by_protocol': affected('@osstack/protocol', [(p, c) for p, c, k in typed_edges if k == kind]),
        'impacted_by_knowledge': affected('@osstack/knowledge', [(p, c) for p, c, k in typed_edges if k == kind]),
    } for kind in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')},
    'impacted_by_protocol': affected('@osstack/protocol'),
    'impacted_by_knowledge': affected('@osstack/knowledge'),
}, indent=2))
