import type { ContainedCommandOptions } from './contained-command.js';
// Optional Docker support does not load HTTP/Zod on the ordinary CLI startup path.
export async function createContainedCommandExecutor(options: ContainedCommandOptions) {
  const { ContainedCommandExecutor } = await import('./contained-command.js');
  return new ContainedCommandExecutor(options);
}
export async function createContainedCommandAdapter(options: ContainedCommandOptions) {
  const { createContainedCommandAdapter: create } = await import('./adapters/contained-command.js');
  return create(options);
}
export type { ContainedCommandOptions, ContainedStopReceipt, ContainedCommandExecutor } from './contained-command.js';

export async function prepareContainedImage(options: import('./contained-image.js').ContainedImageOptions, files: readonly import('./contained-image.js').ContainedCandidateFile[]) {
  const { prepareContainedImage: prepare } = await import('./contained-image.js');
  return prepare(options, files);
}
export type { ContainedImageOptions, ContainedImageReceipt, ContainedCandidateFile } from './contained-image.js';
export type { ContainedCommandResult } from './contained-command.js';
