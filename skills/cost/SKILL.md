---
name: cost
description: Show AI credits, dollars, tokens and tool calls per prompt and per session for GitHub Copilot CLI (/cost help for options).
---

Normally the ai-cost-drilldown hook answers /cost before this text reaches you. If you are
reading it, the hook did not run, so produce the report yourself:

1. Run this command with the shell tool, replacing ARGS with the text after "ARGUMENTS:"
   below (nothing if there is none). The script is two directories above this skill's
   base directory:

       node "<base directory>/../../bin/cost.js" ARGS

2. Reply with the command's output exactly as printed, and nothing else. Do not
   summarise, reformat or comment on it.
