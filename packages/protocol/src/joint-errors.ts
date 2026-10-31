// Internal: not re-exported by the joint subpath.
/** Run neutral canonical-JSON code under the joint error code. */
export function joint<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof Error && error.message === 'INVALID_CANONICAL_JSON') throw new Error('INVALID_JOINT_JSON');
    throw error;
  }
}
