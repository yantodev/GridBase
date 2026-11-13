---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/app.js","public/styles.css"]
---

# SQL workbench

Mode: Operate. The user confirmed the explorer, SQL tabs, editor, and results workflow, with a dark DataGrip New UI reference. This is a code-led build within the existing Java/static-web stack.

## Direction contract

THESIS: A compact database IDE where the database tree, active SQL draft, and its result occupy one screen. Replace the current spacious card dashboard with task-oriented IDE panes.

OWN-WORLD: Graphite tool chrome, darker editor and grid surfaces, cool blue selection and focus, restrained green success and coral errors, system UI text, monospace SQL/data, and consistent outline SVG icons. No JetBrains branding or imported proprietary assets.

STORY: Add connections from the left Database toolbar, expand each data source to schemas/tables, open a console bound to that source, execute the current statement or selection, and inspect the corresponding grid or output without losing other drafts. Each console shows its own connection selector. Selecting another explorer root does not redirect existing consoles.

FIRST VIEWPORT: A 42px title bar; 42px tool rail; roughly 260px collapsible explorer; horizontal console tabs; editor above a resizable Results/Output dock; 26px status bar. Execute stays visible in the console toolbar. On narrow screens the explorer becomes an accessible overlay and toolbars wrap without blocking SQL or results.

FORM: User-pinned DataGrip New UI, explicitly confirmed dark. No direction roll applies to this named reference; seed: none (user-pinned).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: opening a table creates or reuses its own console within the originating connection and keeps its SQL and results together. Pane resizing conveys layout changes without decorative animation. Query execution and explorer expansion expose clear loading and error states.

Evidence limit: browser access host unavailable. Use repository tests, synthetic API checks, static inspection, and an independent finish review; do not claim screenshots or live browser interaction.
