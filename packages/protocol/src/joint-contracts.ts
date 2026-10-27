import { z } from 'zod';
import { parseJointJson, parseJointJsonBytes } from './joint-json.js';
import { SourcePin, MethodBinding, CheckBinding, TrialPermit, MethodArtifact, ContextReceipt, SupportProfile, MethodRecipe, MethodProposal, ArtifactRequirements } from './method-binding.js';
import { RecoveryReceipt, RecoveryRequest, RecoveryProofEnvelope } from './joint-recovery.js';
import { MethodMaterial } from './method-materials.js';
import { OracleLifecycle, GateEvidence, MigrationSpec, JointError } from './joint-lifecycle.js';
import { SourceSnapshot, MethodInput, EnvironmentBinding, ScenarioBinding, CheckRegistry } from './joint-evidence.js';
export const JointContract = z.union([SourcePin, MethodBinding, CheckBinding, TrialPermit, MethodArtifact, ContextReceipt, RecoveryReceipt, SupportProfile, MethodRecipe, MethodProposal, ArtifactRequirements, RecoveryRequest, RecoveryProofEnvelope, MethodMaterial, OracleLifecycle, GateEvidence, MigrationSpec, JointError, SourceSnapshot, MethodInput, EnvironmentBinding, ScenarioBinding, CheckRegistry]);
export type JointContract = z.infer<typeof JointContract>;
export function decodeJointContract(raw: string): JointContract { return JointContract.parse(parseJointJson(raw)); }

export function decodeJointContractBytes(raw: Uint8Array): JointContract { return JointContract.parse(parseJointJsonBytes(raw)); }
