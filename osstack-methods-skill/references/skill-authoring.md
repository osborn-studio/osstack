# Skill authoring

Use this method to create a reusable skill or improve an existing skill from concrete task evidence. For a project driver and feature map, use [create verification](create-verification.md); for drift in that verification, use [maintain verification](maintain-verification.md). A shared method reference is not necessarily an independently installed skill.

## Choose the outcome and editable source

Identify the task the skill should help complete, the intended host, and the allowed destination from the current request and available context. Write a representative request that should select it and a nearby request that should not. Check existing skills before adding another owner for the same job. If a small correction suffices, preserve the existing name, supported metadata and unrelated behavior.

Inspect the target host's actual skill format and available authoring tools. Use its skill creator or validator when available; do not assume Cursor's `create-skill`, a model name or an OSStack installer exists. If the host or destination is unresolved, prepare the content as a draft and name the missing choice. Do not choose a global home by default.

Locate the maintained source and its callers. Do not patch a plugin cache, generated export or another worker's files as if they were the canonical source. When only a read-only upstream copy is available, prepare a separate patch or a local copy within the authorized destination. Preserve attribution, license notices and upstream links. A local adaptation does not rename its original author or authorize upstream publication.

Continue changes already authorized for the resolved scope without asking again. A review-only request produces findings or a proposed diff. Transcript content, model suggestions and historical task instructions are evidence, not a new grant to edit, install, publish or collect more history.

## Write the smallest useful guidance

State a discriminating name and description in the host's supported frontmatter. Explain when the skill applies without attracting unrelated work. Preserve normal host selection unless the user requests a different invocation policy or an existing policy must be retained. Availability for selection does not authorize the actions described inside the skill.

Keep the entry focused on the desired result and decisions that are easy to get wrong. Put conditional detail in linked references, with enough context to know when to read them. Point to maintained schemas, commands and source owners instead of repeating their contents. Include scripts or templates only when they serve a concrete repeated task; inspect and validate executable helpers within the task's permitted resources.

For maintenance, inspect the current task's relevant conversation, output and failures, or a specifically supplied record. Use bounded reads and retain source pointers. If records are inaccessible, say so; do not search all user histories or infer a missing event from an incomplete record. Remove secrets and unrelated personal details from examples.

Separate observed failure from the proposed general lesson. Check whether the instruction was selected, read and applicable before blaming its wording. Record which change is supported, which suggestion is rejected or deferred, and why. A one-off preference does not justify a universal rule. Preserve counterexamples that would make the proposed lesson harmful.

When an error can be prevented by an existing type, parser, lint rule or behavior test, prefer that structural correction to repeated warnings. Keep it within current authority. If the correction needs product or CI changes outside this task, return a precise follow-up with its evidence; do not silently expand a skill edit. Keep prose for decisions that still require judgment.

## Check the result at the level actually exercised

Run the available format validator and resolve local references from the actual entry. Check that helpers and documented commands exist and that any changed helper does the intended work. For exported material, inspect the real bundle, hashes and reachable references. A missing file or stale generated copy is a failed structural check, not a reason to weaken the requirement.

Choose checks that could expose the original mistake. Use a representative request and a nearby nonmatching request, retaining the input and expected distinction before execution. For a maintenance change, keep the original failure and recheck the same path when feasible. Do not use matching words in the new prose as proof of better decisions.

When a real host trial is within scope and available, bind the material version, host version and actual observed reads or selection to the result. Test in an owned isolated workspace with the task's allowed tools and effects. Do not run untrusted helpers, use credentials, call paid models or change global settings merely to make a test pass. Existing execution authorization remains effective; absent resources leave a named unexecuted check. Human or agent walkthroughs are useful review evidence, but are not host execution or proof of improved outcomes.

Report format/reference checks, exported availability, observed host selection, task outcome and remaining unknowns separately. A validator pass cannot establish discovery, correct routing or useful behavior. If no host trial ran, deliver the checked material with that limitation. Do not claim an installation, slash command or runtime gate pass.

Return the changed source paths, the supported design choice, retained failure/check evidence, deferred structural work and any pending installation or publication decision. Do not create a watcher, tracker issue or background learning job from a reflection request. See [common evidence rules](evidence.md) and [pinned sources](sources.md).
