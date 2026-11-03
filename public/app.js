const state = {
  query: "",
  running: false,
  history: [],
};

const editor = document.querySelector("#sql-editor");
const lineNumbers = document.querySelector("#line-numbers");
const runButton = document.querySelector("#run-query");
const resultsEmpty = document.querySelector("#results-empty");
const resultsLoading = document.querySelector("#results-loading");
const resultsError = document.querySelector("#results-error");
const resultsTable = document.querySelector("#results-table-wrap");
const toast = document.querySelector("#toast");

function updateEditorMeta() {
  state.query = editor.value;
  const lineCount = Math.max(1, editor.value.split("\n").length);
  lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  document.querySelector("#char-count").textContent = `${editor.value.length.toLocaleString("id-ID")} characters`;
}

function setResultMode(mode) {
  resultsEmpty.hidden = mode !== "empty";
  resultsLoading.hidden = mode !== "loading";
  resultsError.hidden = mode !== "error";
  resultsTable.hidden = mode !== "table";
}

function setToast(message) {
  toast.textContent = message;
  window.clearTimeout(setToast.timeout);
  setToast.timeout = window.setTimeout(() => { toast.textContent = ""; }, 2600);
}

function renderResults(result) {
  document.querySelector("#row-count").textContent = `${result.rowCount.toLocaleString("id-ID")} rows${result.truncated ? " · capped" : ""}`;
  document.querySelector("#duration").textContent = `${result.durationMs} ms`;

  resultsTable.replaceChildren();
  if (!result.columns.length) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = "Query selesai tanpa result set.";
    resultsTable.append(note);
    setResultMode("table");
    return;
  }

  const table = document.createElement("table");
  table.className = "results-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  result.columns.forEach((column) => {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = column;
    headerRow.append(header);
  });
  thead.append(headerRow);
  const tbody = document.createElement("tbody");
  result.rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    result.columns.forEach((column) => {
      const cell = document.createElement("td");
      cell.textContent = row[column] ?? "";
      cell.title = cell.textContent;
      tableRow.append(cell);
    });
    tbody.append(tableRow);
  });
  table.append(thead, tbody);
  resultsTable.append(table);
  if (result.truncated) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = "Showing the first 1,000 rows to keep the workbench responsive.";
    resultsTable.append(note);
  }
  setResultMode("table");
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  document.querySelector("#history-count").textContent = state.history.length;
  list.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your recent runs will appear here.";
    list.append(empty);
    return;
  }
  state.history.slice(0, 5).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    const title = document.createElement("strong");
    title.textContent = item.sql.split("\n")[0].slice(0, 34);
    const time = document.createElement("small");
    time.textContent = `${item.rows} rows · ${item.time}`;
    button.append(title, time);
    button.addEventListener("click", () => {
      editor.value = item.sql;
      updateEditorMeta();
      editor.focus();
      setToast("Query loaded from history");
    });
    list.append(button);
  });
}

function formatQuery() {
  const formatted = editor.value
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",\n  ")
    .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING)\s+/gi, "\n$1 ")
    .trim();
  editor.value = formatted;
  updateEditorMeta();
  setToast("Query formatted");
}

async function runQuery() {
  if (state.running) return;
  state.running = true;
  runButton.disabled = true;
  runButton.querySelector("span:nth-child(2)").textContent = "Running…";
  setResultMode("loading");
  document.querySelector("#row-count").textContent = "— rows";
  document.querySelector("#duration").textContent = "—";

  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: editor.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Query gagal dijalankan.");
    renderResults(payload);
    state.history.unshift({ sql: editor.value, rows: payload.rowCount, time: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) });
    state.history = state.history.slice(0, 5);
    renderHistory();
    setToast("Query completed");
  } catch (error) {
    document.querySelector("#error-message").textContent = error.message;
    setResultMode("error");
  } finally {
    state.running = false;
    runButton.disabled = false;
    runButton.querySelector("span:nth-child(2)").textContent = "Run query";
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    const badge = document.querySelector("#health-badge");
    badge.textContent = health.configured ? "ready" : "needs setup";
    badge.className = `health-badge ${health.configured ? "" : "is-error"}`;
    document.querySelector("#connection-detail").textContent = health.configured ? "Read-only session · credentials ready" : "Set server-side credentials to connect";
    if (health.target) document.querySelector("#connection-host").textContent = health.target.replace(/^jdbc:hive2:\/\//, "").split(";")[0];
  } catch {
    document.querySelector("#health-badge").textContent = "offline";
    document.querySelector("#health-badge").className = "health-badge is-error";
    document.querySelector("#connection-detail").textContent = "Workbench API is not reachable";
  }
}

editor.addEventListener("input", updateEditorMeta);
editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
runButton.addEventListener("click", runQuery);
document.querySelector("#format-query").addEventListener("click", formatQuery);
document.querySelector("#copy-query").addEventListener("click", async () => {
  await navigator.clipboard.writeText(editor.value);
  setToast("Query copied");
});
document.querySelector("#new-query").addEventListener("click", () => {
  editor.value = "";
  updateEditorMeta();
  setResultMode("empty");
  editor.focus();
});
editor.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery();
  }
});
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    if (button.dataset.view === "history") document.querySelector("#history-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
    else editor.focus();
  });
});

updateEditorMeta();
renderHistory();
checkHealth();

