---
name: GridBase
description: A compact dark database workbench with graphite panes, blue selection, and monospace SQL and data.
colors:
  editor: "#1e1f22"
  chrome: "#2b2d30"
  tree: "#25262a"
  border: "#393b40"
  text: "#dfe1e5"
  muted: "#a8adb8"
  blue: "#88b4fa"
  selection: "#2d4264"
  green: "#87c58a"
  error: "#f4a09c"
  toolbar: "#242529"
  hover: "#393c43"
  editor-rule: "#303136"
  action: "#344c38"
  action-text: "#c9eccb"
  action-border: "#527d57"
  action-hover: "#3b5c40"
  sql-keyword: "#cf9b69"
  sql-string: "#93b87f"
  sql-number: "#9fbff2"
  sql-comment: "#9299a5"
  sql-identifier: "#c6b6ec"
typography:
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.5
  pane-title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "0"
  data:
    fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  flat: "0"
  tree-control: "2px"
  control: "4px"
  completion: "5px"
  dialog: "7px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "20": "20px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 9px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-tool:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "4px 7px"
  button-icon:
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "4px"
    size: "28px"
  input-search:
    backgroundColor: "{colors.editor}"
    textColor: "{colors.text}"
    typography: "{typography.small}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
    height: "28px"
  tool-navigation:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.muted}"
    width: "42px"
  console-tab:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.flat}"
    height: "38px"
  console-tab-active:
    backgroundColor: "{colors.editor}"
  source-row:
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "0 6px"
  source-row-selected:
    backgroundColor: "{colors.selection}"
  console-connection:
    backgroundColor: "{colors.editor}"
    textColor: "{colors.text}"
    typography: "{typography.small}"
    rounded: "{rounded.control}"
    height: "28px"
  sql-editor:
    backgroundColor: "{colors.editor}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    rounded: "{rounded.flat}"
    padding: "14px 16px"
  results-grid:
    backgroundColor: "{colors.editor}"
    textColor: "{colors.text}"
    typography: "{typography.data}"
    rounded: "{rounded.flat}"
  dialog:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "20px"
  connection-dialog:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    padding: "20px"
    width: "min(700px, calc(100% - 32px))"
---

# Design System: GridBase

## Overview

**Creative North Star: "DataGrip New UI workbench"**

The implemented world follows the user's pinned dark DataGrip New UI reference: graphite tool chrome, darker editing surfaces, restrained state colors, and compact controls. The interface gives multiple data sources, their database objects, SQL, and returned data a shared working frame. Each console carries its own connection, dialect, and results. System UI text carries controls and navigation; monospace carries SQL, data, and measurements. There is no display type role.

Durable product commitments are the GridBase name, the dark IDE character, and keeping objects, SQL, and results within one working screen. This record describes `public/styles.css`, `public/index.html`, and the component and layout behavior in `public/app.js`. It records implementation evidence, not visual approval: the browser host was unavailable, desktop and mobile captures are missing, and the finish review requires recapture. Apparent legibility and responsive fit still need rendered verification; source values are not proof of that verification.

**Key Characteristics:**

- Dense pane boundaries and aligned toolbars rather than spacious dashboard cards.
- Blue selection and focus, green execution and connection success, coral errors.
- Flat working surfaces with soft shadows reserved for floating layers.
- Authored outline SVG icons and monospace SQL and data.

## Colors

Graphite neutrals provide the structure; cool blue identifies interaction, while restrained semantic colors identify execution and state. The frontmatter preserves the source's exact color strings. Sidecar tonal ramps are synthesized OKLCH preview metadata, not additional implemented palette tokens.

### Primary

- **Blue:** Focus outlines, active-tab underlines, database and table icons.
- **Selection:** Active tool-rail background, selected data-source root, and keyboard-focused result rows.

### Secondary

- **Green:** Configured connection status dot.
- **Action / Action Text / Action Border / Action Hover:** The Execute, Save, and Connect control family; a subdued green fill with pale green text and a visible edge.
- **Error:** Connection, metadata, and execution error text and status dots.
- **SQL Keyword / String / Number / Comment / Identifier:** Syntax roles inside the editor. These are code-reading colors, not a general decorative palette.

### Neutral

- **Editor:** Main editing canvas, fields, and the results working area.
- **Chrome:** Title bar, rail, console strip, dock header, status bar, floating panels, and grid headers.
- **Tree:** Explorer background and sticky row-number cells.
- **Border:** Structural pane separators and control borders.
- **Text / Muted:** Primary content and secondary labels, respectively.
- **Toolbar / Editor Rule:** Quiet toolbar surfaces and internal editor divisions.
- **Hover:** Shared enabled-button hover fill.

### Named Rules

**The State Color Rule.** Blue identifies interaction; green identifies execution or connection success; coral identifies errors. Keep SQL syntax colors inside code.

## Typography

**Body Font:** The platform UI stack recorded in `typography.body`.
**Label/Mono Font:** The stack recorded in `typography.code`; JetBrains Mono is requested by name but is not bundled or loaded by the HTML. The installed fallback determines the actual rendered face.

**Character:** Compact application typography supports scanning panes and reading data. Size changes are small and functional, with weight doing much of the work in pane headings. The implementation has no hero, display, or marketing headline scale.

### Hierarchy

- **Title:** Dialog title role; result-state headings share this size, while row-detail uses a smaller local variant.
- **Pane Title:** Application and pane headings, using a compact semibold treatment.
- **Body:** Console tabs, explorer objects, buttons, and other working controls.
- **Small:** Search inputs, toolbar context, explanatory copy, history SQL, and row data where appropriate.
- **Label:** Status bars, counts, timestamps, caret position, and secondary measurements. Secondary text stays at least (12px), including narrow-screen measurements.
- **Code:** SQL editor and line numbers share the same fixed line rhythm, tab size (2), and zero tracking.
- **Data:** Results use tabular numerals and monospace text. Grid headers step up to medium weight (500).

Explanatory empty-state copy is capped at (65ch); SQL and grid cells use horizontal scrolling rather than a prose measure. Row detail and output wrap long values. The data role's table line-height is distinct from the editor's fixed line-height.

### Named Rules

**The Content Type Rule.** Use the UI stack for application controls and the monospace stack for SQL, returned values, and measurements. Preserve matching editor and gutter metrics.

## Layout

The desktop shell fills the viewport using `100vh` with a `100dvh` override and a minimum height (520px). Its columns are a tool rail (42px), explorer (260px initially), splitter (4px), and a flexible workbench. Rows are a title bar (42px), flexible working area, and status bar (26px). The desktop explorer collapses to zero width without removing the tool rail.

The workbench stacks a console strip (38px), editor, results splitter (5px), and flexible results dock. The editor starts at (45%) with a minimum (140px) and a maximum that leaves room below (`calc(100% - 185px)`). Results retain a minimum height (130px). Explorer resizing is clamped to (200–420px); editor resizing is clamped to (20–75%). Pointer resizing is immediate. Keyboard arrows resize by (10px) or (5%), and Home/End reach each limit. These percentages are requested layout values; CSS minimum and maximum sizes still constrain the visible pane.

Controls primarily use small even spacing steps from the frontmatter; local (5px), (7px), and (9px) adjustments are also present. Pane and toolbar inset commonly falls between (8–14px). Explorer rows are at least (29px) tall. Results cells use a declared height (29px) and compact padding, with sticky column headings and row numbers. Long tabs and database names truncate; tabs and results scroll inside their own regions.

The Database view keeps Add connection and the settings control in a compact left toolbar above object filtering and the data-source roots. Each source groups its own schema tree and compact metadata caption. The editor toolbar wraps at every width to accommodate its per-console connection select; that field has a preferred flex basis (240px), minimum width (90px), maximum width (280px), and height (28px).

The connection manager is a native dialog with width `min(700px, calc(100% - 32px))`, maximum height `min(760px, calc(100% - 32px))`, and internal scrolling. Its saved-source list (205px) sits alongside a flexible field column with a gap (18px). The saved list starts at a minimum height (280px); host and port share a field grid with a port column (120px) and gap (10px). Action buttons wrap.

- At widths up to (960px), the keyboard execution hint, project name, and title divider are hidden.
- At widths up to (700px), the explorer becomes a fixed overlay below the title bar and above the status bar. Its left edge remains after the rail (42px), and its width is `min(300px, calc(100vw - 54px))`. The sidebar splitter disappears, the shell minimum height becomes (560px), and the workbench occupies the remaining column. The overlay starts closed, dims the workbench, and makes the workbench inert while open. Tool buttons, backdrop, and Escape close it and restore focus to its rail button. Gutters, dock tabs, labels, and padding compact. The connection select grows from a flex basis (120px), its visible label becomes visually hidden while remaining associated, and nonempty table context moves to a full toolbar row. The page-size label and server-state text hide.
- At widths up to (620px), the connection manager becomes one column, the saved-source list uses minimum height (100px) and maximum height (150px), and dialog padding reduces to (14px).
- At widths up to (420px), the product icon hides, the connection label shortens, the toolbar minimum becomes (62px), and the editor minimum becomes (165px).

These breakpoints describe source behavior. Desktop and mobile fit remain unverified without the missing captures.

## Elevation & Depth

Working panes are flat and separated by tone and thin rules. Shadows distinguish the completion panel, dialogs, and the mobile explorer overlay from the working plane. The editor's inset focus edge is a focus state, not elevation. There are no authored button hover transitions or pane entrance animations.

### Shadow Vocabulary

- **Completion:** `0 8px 25px #0006` beneath SQL suggestions.
- **Dialog:** `0 16px 48px #0008` beneath connection, rename, and row-detail dialogs; the native dialog backdrop uses `#0008`.
- **Mobile Explorer:** `8px 0 24px #0006` beside the fixed explorer; its backdrop uses `#0006`.

The loading result icon pulses over (1.4s) with `ease-in-out`, reaching opacity (.3) halfway through the loop. Reduced-motion preference removes that animation. Resize and selection changes are direct.

### Named Rules

**The Working Plane Rule.** Keep the explorer, editor, and grid flat. Reserve soft, offset shadows for the implemented floating layers.

## Shapes

The shell and dock form rectangular, edge-aligned panes. Tabs, table headers, history rows, and the editor keep square corners. Small tree controls use the tree-control radius; ordinary buttons and fields use the control radius. Completion and dialog surfaces use their larger, still restrained radii. A small circular dot communicates connection state.

Single-pixel borders mark fields, grids, and pane divisions. The active console and dock tabs use a bottom indicator (2px). Outline SVG icons share rounded line caps and joins, a stroke width (1.4), and a base size (18px), with smaller local variants. The Execute triangle is filled intentionally. No raster assets, icon fonts, emoji icons, or proprietary branding assets are used.

## Components

### Buttons

Compact toolbar controls keep actions adjacent to their working surface.

- **Primary:** Execute, Save, and Connect share the green action family, control radius, padding (4px 9px), and minimum height (28px).
- **Tool:** Transparent resting fill, padding (4px 7px), minimum height (28px), and the shared hover fill.
- **Icon:** Square (28px) controls with padding (4px); per-source console/settings controls shrink to (26px), and close buttons inside console tabs shrink to (24px).
- **Text:** Small utility actions use (12px) text and a minimum height (27px).
- **Focus / Disabled:** The shared focus outline is blue (2px), offset inward (-2px). Disabled controls use opacity (.45) and the default cursor. Execute remains in the editor toolbar at narrow widths.

### Inputs / Fields

Dark, bordered controls remain visually attached to their toolbars.

- **Style:** Editor-colored fill, main text, border-colored edge, control radius, and padding (5px 8px).
- **Search:** Explorer search is (28px) tall; returned-row search is (26px) tall. Placeholder text uses Muted at full opacity.
- **Focus:** Shared blue inset outline. The SQL textarea instead uses a single inset focus edge (`#5678ab`).
- **Connection Select:** The per-console native select shares the field fill, border, control radius, and small UI text. Its options combine connection name, database type, and disconnected state. It is disabled while that console executes.
- **Errors:** Connection and execution errors appear in their corresponding notices, form status, states, and output; no field-specific error variant is implemented. Nonempty connection-form status uses the existing amber notice text (`#f2cc8f`), including test feedback; it has no separate success style.

### Navigation

Rail and tabs describe working context rather than page hierarchy.

- **Tool Rail:** Graphite strip with muted SVG buttons (32px × 34px). The selected tool uses Selection and pale blue foreground (`#c6dcff`). The same rail opens or closes the explorer and history views.
- **Console Tabs:** Rectangular tabs (110–230px wide) with truncating names, a blue active underline, and close controls. Tabs scroll horizontally. Arrow keys and Home/End move the active tab; close remains disabled while its console runs.
- **Dock Tabs:** Results and Output use muted resting text, main active text, a subtly raised tone, and the same blue bottom indicator. They remain attached to their shared results dock.
- **Explorer:** The Data sources list starts with named source roots, each with disclosure, database icon, new-console control, settings control, and a database-type/state caption. Selected roots use Selection; source controls use muted icons (14px) inside square buttons (26px). Source names truncate, captions wrap, and adjacent source groups separate by (8px). Connected roots expose independent schema, table, and column loading/error states. Nested left insets are (24px), (40px), and (78px), respectively. Tables and source icons use Blue; schema icons use a restrained violet (`#b2acdf`). Disconnected sources retain an explicit reconnect caption and disable their new-console control.

### Containers / Dialogs

Persistent content lives in flat panes; focused tasks use floating dialogs.

- **Panes:** Edge-aligned backgrounds and single-pixel divisions; no card grid is implemented.
- **Completion:** Compact floating panel with a border, the completion radius, padding (8px), and a native monospace suggestion list. Enter inserts; Escape closes and returns focus to SQL.
- **Connections:** The Database toolbar opens a connection manager using the existing chrome, dialog radius, shadow, and field language. Saved sources appear in a bordered list with name, database type, and remove control; the form uses labeled fields and a checkbox. PostgreSQL, MySQL, and Spark Thrift / Hive share the same controls, with type-dependent fields. Test connection is secondary; Connect is primary. Pending requests expose text and disable test/connect/disconnect actions. Per-source settings open the corresponding profile. Layout dimensions and its one-column breakpoint are recorded in Layout.
- **Rename:** Chrome-colored native dialog with the dialog radius, padding (20px), and width `min(420px, calc(100% - 32px))`.
- **Row Detail:** Wider dialog, capped at (800px), with a scrollable value table capped at (70vh). Long field names and values wrap; field headers occupy (30%) of the table width.

### SQL Editor

The editor is a synchronized syntax layer and textarea, paired with a noninteractive line-number gutter. Selection, caret, scrolling, and shared metrics keep the two layers aligned. SQL stays on unwrapped lines. The gutter is (49px) wide on desktop and (35px) on narrow screens.

The visible SQL uses the syntax color roles in the frontmatter; the textarea itself has transparent text and a visible caret. In forced-colors mode the syntax layer hides and the textarea returns to `CanvasText`. Tab indents, Escape moves focus to Format, and Ctrl/Cmd+Enter executes the selected SQL or statement at the caret. The source limits drafts to (20,000) characters, including programmatic editor changes.

The active console's connection select determines the title-bar connection name/status, editor dialect label, and footer connection status. Table-specific context displays its namespace and table separately from the selected connection. Changing a console's connection clears its previous results and table context; it does not change other consoles. Missing or disconnected sources are explicit select options/states and keep Execute disabled.

### Results Grid / Output

Data stays attached to its originating console.

The grid uses monospace text, tabular numerals, thin cell rules, a sticky header, and a sticky row-number column (48px). Cells truncate long values at a maximum width (420px); row detail exposes the full value. Enabled sorting controls live in column headers. Hover fills a row with `#283344`; keyboard focus within a row uses Selection. Null is muted and italic. Filtering, export, pagination, metrics, and result/output tabs stay within the dock. Output uses wrapping monospace text.

Empty, loading, error, and write-result states use a small centered icon and concise copy rather than data-shaped placeholders. The connection status and execution state include text as well as color.

## Do's and Don'ts

### Do:

- **Do** keep persistent working areas edge-aligned, compact, and separated by tone and thin rules.
- **Do** preserve the State Color Rule and keep syntax colors associated with SQL roles.
- **Do** keep SQL and gutter metrics identical and reserve monospace for SQL, data, and measurements.
- **Do** include visible keyboard focus and pair connection or query state colors with text.
- **Do** preserve pane-level scrolling, truncation with access to full content, and the overlay behavior at narrow widths.

### Don't:

- **Don't** replace the confirmed dark IDE world with a spacious card dashboard.
- **Don't** add decorative shadows to persistent explorer, editor, or results panes.
- **Don't** introduce a display type voice into the compact application hierarchy.
- **Don't** replace the consistent SVG icon system with text glyphs or proprietary branding assets.
- **Don't** treat source inspection or synthetic controller tests as rendered design approval; capture desktop and mobile before claiming visual fit.
