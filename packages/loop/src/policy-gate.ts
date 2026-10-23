/** Optional host-owned lease covering every effect of a Loop invocation. */
export interface LoopLifecycleLease {
  release(): Promise<void>;
  retain(reason: string): void;
}
export type LoopLifecycleAdmission = (context: { workspacePath: string }) => Promise<LoopLifecycleLease>;
