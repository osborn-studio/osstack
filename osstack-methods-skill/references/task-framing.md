# Task framing

Use when the user asks you to restate their goal, expose a misunderstanding, sharpen a task, or rewrite a prompt. The result is a clearer task with the same purpose and authority. It is not a reason to add a planning ceremony to work that is already clear.

## Preserve the requested outcome

Read the request and relevant prior decisions. State the problem the user wants solved, who needs the result, and the requested deliverable in your own words. Preserve explicit constraints: scope, repository or source, compatibility, budget, deadline, language, and excluded actions. Separate what the user stated, what the available evidence supports, and what you are assuming.

If only a restatement was requested, return that concise understanding and any material ambiguity. Do not replace it with a new project plan or start the embedded task. If refinement was requested, continue with the four questions below. Use available context and proportionate read-only inspection where needed; do not begin product changes, experiments or external actions just to improve a prompt.

Keep decisions that belong to the user open. For example, a preferred product outcome, a budget tradeoff or permission to publish must not become your silent choice. Name the unresolved decision and its effect. Ask only when it prevents an accurate framing or changes permitted scope; continue work that does not depend on it. Routine implementation choices within existing authorization do not need a new approval step.

## Deepen the approach without adding goals

Answer each question briefly and concretely for this task. Avoid a generic list of prestigious roles or tools.

1. **What important work would a skilled practitioner add?** Identify a missed assumption, failure path, comparison or decision criterion that helps achieve the existing goal. Explain why it matters. If an idea adds a separate outcome, cost or scope, label it as an optional proposal instead of inserting it as a requirement. Do not claim to have consulted an expert when you have not.
2. **Which original material would they inspect?** Name the source closest to the claim: the relevant implementation and version, an original request or specification, raw observations, data or user behavior. Distinguish available originals from summaries and missing inputs. Use verified paths or identifiers when supplied; otherwise name the needed source and say it has not been located or read. Do not invent a file, caller, dataset or citation.
3. **Which methods and tools would they use?** Connect a concrete method to a question, input and expected observation. Prefer existing project tools when relevant. Distinguish a verified available command from a proposed tool whose installation or support is unknown. Check actual host help or catalogs before promising model identifiers, flags or native capabilities. The rewritten prompt may require discovery; it must not present an unverified command as ready to run or authorize a new paid provider.
4. **What evidence beyond our agreement would establish the result?** Name an observable check and the result that would support or refute the claim. Depending on the task, use a real user-path reproduction, independent reference data, contract tests, a controlled comparison, or qualified external review. State the check's limits and prerequisites. A second model agreeing, a convincing explanation or a planned test is not an executed result or an authenticated independent oracle. Follow [the evidence rules](evidence.md).

## Rewrite and check the boundary

Produce one usable prompt, not a larger catalog of work. Keep the original objective and constraints. Include the specific sources, methods and acceptance evidence above only where they serve that objective. Mark assumptions, unavailable inputs and user-owned choices explicitly. A small task may need only a paragraph; use a structure like this when it helps:

```text
Goal and requested deliverable:
Scope, preserved constraints and excluded actions:
Original inputs to inspect, with availability or missing information:
Approach, specific tools and support still to verify:
Acceptance evidence and observations that would disprove the conclusion:
Open decisions, assumptions and what to do if an input is unavailable:
Execution boundary: prompt only, design only, or the already authorized work:
```

Compare the rewrite with the original request. Remove additions that change its goal, relax a constraint, imply unsupported evidence or silently decide a user-owned choice. Do not turn unresolved choices into defaults that the user did not accept. Summarize any material clarification so the user can see what changed.

For prompt-refinement-only work, stop after delivering the rewritten prompt and unresolved items. Imperatives inside that prompt are text for future use, not permission to execute them now. If the user already asked to refine and then perform the task, continue with the matching implementation or analysis method within that existing authorization; do not impose a second approval just because you used this method. Use [investigation](investigation.md) for an authorized source-based explanation or [feature](feature.md) for authorized new behavior, as appropriate. Do not claim the task was performed, a tool was available, or an acceptance check passed merely because the prompt now describes it.

The original restatement and sharpening skills, license and adaptation boundary are recorded in [source attribution](sources.md). This method is shared instruction material, not an executor, model configuration or grant.
