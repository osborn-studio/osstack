import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { deliveryContract } from "@osstack/supervisor";
import { expect, it } from "vitest";
import { handleAttentionPlanning } from "./attention-planning-command.js";
it("labels legacy supplied verification as offline planning, never host execution evidence",async()=>{
 const root=realpathSync(createScratchDirSync("tests","legacy-contract-label"));
 try {
  const contract={version:1,contract_id:"legacy",parent_contract_id:null,mode:"implement",repo_path:root,head:"a".repeat(40),goal:"test",required_verification:["pnpm test"],review_required:true,completion:"local_verified"};
  const input=join(root,"input.json"),evidence=join(root,"evidence.json");
  writeFileSync(input,JSON.stringify(contract));
  writeFileSync(evidence,JSON.stringify({digest:deliveryContract(contract).digest,mode:"implement",head:contract.head,passed:["pnpm test"],reviewed:true,completion:"local_verified"}));
  const output:string[]=[];
  expect(await handleAttentionPlanning(["contract","--input",input,"--evidence",evidence],text=>output.push(text))).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({verified:true,qualification:"offline_supplied_data_only",execution_verified:false,authority:"existing_approval_required"});
 } finally {rmSync(root,{recursive:true,force:true});}
});
