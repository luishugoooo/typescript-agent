---
'@openrouter/agent': patch
---

Deliver tool-loop and stream cancellation failures through the turn broadcaster instead of leaving detached rejected promises that can terminate the host process. Preserve the broadcaster's first terminal outcome for concurrent and late consumers.
