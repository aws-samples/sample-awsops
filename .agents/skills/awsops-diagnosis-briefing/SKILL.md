---
name: awsops-diagnosis-briefing
description: Author or review a customer-facing PowerPoint or HTML briefing from an AWSops six-pillar diagnosis, with current architecture diagrams, scoped comparisons, and an actionable improvement plan.
---

Start with the authorized saved diagnosis and its assessment date. If the customer supplies a reference deck, inspect its current-state, detailed analysis, proposed-design and implementation slides. Borrow the way it explains a decision. Keep the reference customer's names, measurements, diagrams and design choices out of the new deck.

**Open with the decision.** Name the affected workload or setting, why a customer should care and who can make the first decision. Spend the most space on the decisions supported by this assessment. Carry all six Well-Architected pillars through to either a concrete decision or a concise, explicitly scoped assessment.

**Draw the assessed architecture.** Use editable nodes and connectors. An observed call can have an arrow between its recorded caller and callee. A stored placement, security-group association, permitted path, DNS lookup or undirected flow gets its own label and neutral connector. Preserve the resource or trace identity, region, source and material time or binding qualifier. Keep equally named trace nodes distinct. An inventory without verified endpoint pairs can still show bounded groups of components and the decision each group informs. Place these groups without connecting them. A single service path spanning ingress, runtime and database needs evidence for each hop. Revisit the part of the diagram that the priority finding actually affects.

**Make each deep dive answer a customer question.** Put the current setting or measured value next to its workload, unit, period and comparison. Explain the consequence under a stated business requirement. Show the first test, who should perform it and which result changes the decision. For performance, distinguish independent peaks from same-request observations. For cost, distinguish billed examples from a total or potential saving. For resilience, obtain the recovery objective before prescribing a retention period. Surface uncertainty where it changes the choice.

**Make the proposed state testable.** Label design alternatives and conditional actions as proposals. Show how a customer moves from current state through one scoped trial to a decision to roll out, revise or stop. Include the business owner, baseline, success condition and rollback trigger when the evidence supports them. Put material conditions and later phases on visible slides. Speaker notes can hold provenance and extra detail.

**Use the export that customers use.** For AWSops, build from the same saved Markdown through the web presentation model and both renderers. The worker's current-architecture relation table already supplies typed pairs and source scope. Inspect the actual output when a report has only inventory, different-language headings, a partial result or a table that spans pages. Never add a model or cloud query solely for export.

Review the rendered deck at presentation size. Pick a diagram line and trace it to its exact source row. Check that a reader can find the first decision, the relevant resource, a comparison, the last roadmap step and its acceptance condition without notes. A visual inspection should include the densest slide and a long identifier, in addition to the cover.
