import { GraphContractError } from '@osstack/protocol';
/** Graph workers require real Node processes and package-relative module files.
 * Bun compiled executables cannot provide this deployment contract. Legacy
 * commands remain available; never fall back to an in-process graph engine. */
export function assertGraphPlatform(versions: { node: string; bun?: string } = process.versions): void {
  if (versions.bun) throw new GraphContractError('GRAPH_DISTRIBUTION_UNSUPPORTED');
  const [major, minor] = versions.node.split('.').map(Number);
  if (!major || major < 20 || (major === 20 && (!minor || minor < 6))) throw new GraphContractError('GRAPH_NODE_VERSION_UNSUPPORTED');
}
