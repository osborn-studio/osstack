// Sandbox fixture only. No package exports this hook. It never calls a fence,
// mints credentials, starts a process, or replaces a publication capability.
const installed = new WeakSet();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const identifier = value => text(value) && !/\s/.test(value);
const invalid = suffix => { throw new TypeError(`BRIDGE_SANDBOX_PUBLICATION_HOOK_INVALID_${suffix}`); };
const assertGated = runner => {
  if (!record(runner) || typeof runner.run !== 'function') invalid('ADAPTER');
  if (runner.gated !== true) throw new TypeError('BRIDGE_SANDBOX_PUBLICATION_HOOK_UNGATED');
};

function gitSubcommand(args) {
  let index = 0;
  while (args[index]?.startsWith('-')) {
    const flag = args[index++];
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(flag)) {
      if (!text(args[index])) invalid('GIT_OPTIONS');
      index++;
    } else if (/^(?:-[cC].+|--(?:git-dir|work-tree|namespace|config-env)=.+)$/.test(flag)
      || ['-p', '-P', '--paginate', '--no-pager', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects'].includes(flag)) {
      continue;
    } else return undefined;
  }
  return args[index];
}

function pushMetadata(command, args, options) {
  if (!text(command) || !Array.isArray(args) || Array.from(args).some(arg => typeof arg !== 'string') || !record(options)
    || !text(options.cwd) || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
    || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) invalid('OPTIONS');
  const gate = options.gate;
  if (gate !== undefined && (!record(gate) || !['git_push', 'gh_pr_create'].includes(gate.kind)
    || !identifier(gate.missionId) || typeof gate.fence !== 'function' || !text(gate.remoteTarget) || !text(gate.localTarget))) invalid('OPTIONS');
  if (options.intentId !== undefined && !identifier(options.intentId)) invalid('OPTIONS');
  const subcommand = command === 'git' ? gitSubcommand(args) : undefined;
  // Do not silently miss a gated write if a future hardening prefix is unknown.
  if (command === 'git' && subcommand === undefined && gate?.kind === 'git_push') invalid('GIT_OPTIONS');
  if (command !== 'git' || subcommand !== 'push') return undefined;
  if (!gate || gate.kind !== 'git_push' || !identifier(options.intentId)
    || (gate.intentId !== undefined && gate.intentId !== options.intentId)) invalid('OPTIONS');
  return Object.freeze({ missionId: gate.missionId, intentId: options.intentId });
}

/**
 * Install before createProductionLiveBridge captures revisionPublicationAdapters.
 * onBeforePush receives only {missionId,intentId}; it may revoke the fixture's
 * authority file and must return before the original runner starts. It cannot
 * return a gate, permit, result or authorization decision to this helper.
 * restore() is synchronous and idempotent, and disables future captured hooks.
 */
export function installRevisionPublicationHook(ports, options) {
  if (!record(ports) || typeof ports.revisionPublicationAdapters !== 'function') invalid('PORTS');
  if (!record(options) || typeof options.onBeforePush !== 'function'
    || Reflect.ownKeys(options).some(key => key !== 'onBeforePush')) invalid('INSTALL_OPTIONS');
  if (installed.has(ports)) throw new TypeError('BRIDGE_SANDBOX_PUBLICATION_HOOK_ALREADY_INSTALLED');
  const originalFactory = ports.revisionPublicationAdapters;
  const descriptor = Object.getOwnPropertyDescriptor(ports, 'revisionPublicationAdapters');
  const onBeforePush = options.onBeforePush;
  let active = true;
  async function hookedFactory(...factoryArgs) {
    const adapters = await Reflect.apply(originalFactory, this, factoryArgs);
    if (!active) return adapters;
    if (!record(adapters) || typeof adapters.preflight !== 'function' || typeof adapters.localGit !== 'function') invalid('ADAPTER');
    const runner = adapters.runner;
    assertGated(runner);
    const originalRun = runner.run;
    const wrapped = Object.freeze({
      gated: true,
      async run(...invocation) {
        assertGated(runner);
        const metadata = pushMetadata(...invocation);
        if (active && metadata) await onBeforePush(metadata);
        assertGated(runner);
        // The original launcher still owns token acquisition, spawn, and W13's
        // release fence. Preserve its receiver and all invocation references.
        return Reflect.apply(originalRun, runner, invocation);
      },
    });
    return { ...adapters, runner: wrapped, preflight: adapters.preflight, localGit: adapters.localGit };
  }
  try {
    Object.defineProperty(ports, 'revisionPublicationAdapters', { value: hookedFactory, writable: true,
      enumerable: descriptor?.enumerable ?? true, configurable: descriptor?.configurable ?? true });
  } catch { invalid('PORTS'); }
  installed.add(ports);
  return function restore() {
    if (!active) return;
    active = false;
    installed.delete(ports);
    // Do not clobber a later unrelated fixture replacement.
    if (ports.revisionPublicationAdapters !== hookedFactory) return;
    if (descriptor) Object.defineProperty(ports, 'revisionPublicationAdapters', descriptor);
    else delete ports.revisionPublicationAdapters;
  };
}
