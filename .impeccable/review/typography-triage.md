# Typography hook triage

The Stop hook reported tiny-text and flat-type-hierarchy for public/index.html. Reviewed the current dark IDE source and fixed both within the existing layout:

- Secondary labels, column metadata, completion hints, pagination, and status text now use at least 12px at every breakpoint (previously 10–11px).
- Result-state headings now use 16px, while compact pane headings and SQL text remain 13px.
- DESIGN.md typography tokens and descriptions were updated. The sidecar continues to refer to those frontmatter roles; its component previews use unchanged typography values.

The post-change detector reported 0 anti-patterns. Existing advisory palette/scale documentation notes were not expanded into this task. No detector ignores were added. CSS typography-floor checks, design YAML/JSON parsing, and git diff --check passed.

No rendered desktop/mobile verification is claimed; browser-host availability and the previous recapture gate are unchanged.
