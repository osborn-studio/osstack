import { expect, it } from 'vitest';
import { compileGraphSpec } from '../spec-compiler.js';
import { deliveryEpoch } from './code-delivery-v1.js';
const compiled = compileGraphSpec({schemaVersion:1,template:'code-delivery-v1',publication:'artifact_only',
  input:{taskRef:'task',repositoryRef:'repo',baseRevision:'a'.repeat(40),acceptanceRef:'acceptance'},
  limits:{maxEpochs:2,maxBranchAttempts:3,maxConcurrentReaders:2,maxConcurrentWritersPerRepo:1,maxActionStarts:30,tokenReservationLimit:200000,deadlineSeconds:120}});
it('reserves both isolated preparation effects for every bounded verification attempt',()=>{
  const epoch=deliveryEpoch(compiled,0);
  expect(epoch.cost).toEqual({actions:15,tokens:81920});
  expect(epoch.nextCost).toEqual({repair:{actions:15,tokens:81920},review:{actions:2,tokens:16384},tests:{actions:2,tokens:0}});
  expect([1,2,3].map(a=>epoch.preparationSlot('review',a))).toEqual(['main','retry-2','retry-3']);
  expect(epoch.slots.review).toEqual({nodeId:'e0.review',effectSlot:'main'});
});
it.each([0,4,-1,1.5,Infinity])('does not allocate preparation slots beyond compiled attempts: %s',attempt=>{
  expect(()=>deliveryEpoch(compiled,0).preparationSlot('tests',attempt)).toThrow('BRANCH_BUDGET_EXHAUSTED');
});
it('rejects uncompiled epoch and arbitrary node selection',()=>{
  expect(()=>deliveryEpoch(compiled,2)).toThrow('EPOCH_BUDGET_EXHAUSTED');
  expect(()=>deliveryEpoch(compiled,0).node('shell')).toThrow('UNREGISTERED_DELIVERY_NODE');
});
