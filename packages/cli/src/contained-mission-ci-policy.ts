export const GITHUB_CI_SANDBOX = 'osborn-studio/osstack-bridge-sandbox';
export const GITHUB_CI_SANDBOX_ID = 1446327922;
export const GITHUB_CI_PILOT_REPOSITORY = 'osborn-studio/osstack';
const PUBLISHER_ACTOR = 352680398;
const ACTIONS_APP = 15368;

type JobPolicy = { name: string; matrix: Readonly<Record<string, string>>; runnerLabels: readonly string[]; failureStep: string };
export interface GithubCiPolicy {
  readonly repository: typeof GITHUB_CI_SANDBOX | typeof GITHUB_CI_PILOT_REPOSITORY;
  readonly repositoryId: number;
  readonly publisherActorId: number;
  readonly actionsAppId: number;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly workflowBlob: string;
  readonly jobs: readonly JobPolicy[];
}

const fixture = (name: string, node?: string): JobPolicy => ({
  name, matrix: node ? { node } : {}, runnerLabels: ['ubuntu-latest'], failureStep: 'Run test ! -e PROBE_FAIL',
});
export const SANDBOX_CI_POLICY: GithubCiPolicy = {
  repository: GITHUB_CI_SANDBOX, repositoryId: GITHUB_CI_SANDBOX_ID, publisherActorId: PUBLISHER_ACTOR,
  actionsAppId: ACTIONS_APP, workflowId: 407532337, workflowPath: '.github/workflows/ci.yml',
  workflowBlob: '562d683c3e9ab500aea73f09278a00d4cc266db1',
  jobs: [fixture('check'), ...['22', '24'].map(node => fixture(`graph-macos-fixtures (${node})`, node)),
    ...['20.6.0', '22.23.1'].map(node => fixture(`graph-runtime-matrix (${node})`, node))],
};
const ubuntu = ['ubuntu-latest'];
export const PRODUCTION_CI_POLICY: GithubCiPolicy = {
  repository: GITHUB_CI_PILOT_REPOSITORY, repositoryId: 1255570742, publisherActorId: PUBLISHER_ACTOR,
  actionsAppId: ACTIONS_APP, workflowId: 294875045, workflowPath: '.github/workflows/ci.yml',
  workflowBlob: 'ad3dc86ffa37c402912d43688d0ed3670f62c3be',
  // Read macOS first. The Ubuntu check depends on both macOS cells. Its prerequisite
  // failure is never repairable: only a failure in its own exact Test step is.
  jobs: [
    ...['22', '24'].map(node => ({ name: `graph-macos-fixtures (${node})`, matrix: { node },
      runnerLabels: ['macos-15'], failureStep: 'Graph fixtures through macOS temporary-path alias' })),
    { name: 'check', matrix: {}, runnerLabels: ubuntu, failureStep: 'Test' },
    ...['20.6.0', '22.23.1'].map(node => ({ name: `graph-runtime-matrix (${node})`, matrix: { node },
      runnerLabels: ubuntu, failureStep: 'Graph worker and durable SQLite runtime' })),
    { name: 'bridge-offline-node-tests', matrix: {}, runnerLabels: ubuntu, failureStep: 'Bridge offline Node contracts' },
  ],
};

/** Literal paths in the pilot are explicit per authorization. Keep automation away from
 * dependency, verification and runtime configuration. General patch policy also applies. */
export const PILOT_PATH = /^(?:packages\/[a-z][a-z0-9-]*\/src\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.tsx?|docs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md|\.changeset\/[a-zA-Z0-9_-]+\.md)$/u;
