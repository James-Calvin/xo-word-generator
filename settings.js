(function bootstrapSettingsPage(globalScope) {
  const sharedApi = globalScope.LOVE_LANGUAGE_SHARED || {};
  const sharedUtils = sharedApi.utils || {};
  const rulesApi = globalScope.LOVE_LANGUAGE_RULES || {};

  const trimOrEmpty =
    typeof sharedUtils.trimOrEmpty === "function"
      ? sharedUtils.trimOrEmpty
      : (value) => (typeof value === "string" ? value.trim() : "");
  const escapeHtml =
    typeof sharedUtils.escapeXml === "function"
      ? sharedUtils.escapeXml
      : (text) =>
          String(text)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");

  const TRANSITION_SCOPES = Array.isArray(rulesApi.TRANSITION_SCOPES)
    ? rulesApi.TRANSITION_SCOPES
    : ["word", "syllable", "boundary"];
  const SYLLABLE_PATTERN_KEYS = Array.isArray(rulesApi.SYLLABLE_PATTERN_KEYS)
    ? rulesApi.SYLLABLE_PATTERN_KEYS
    : ["single", "initial", "medial", "final"];
  const loadDraftRuleConfig =
    typeof rulesApi.loadDraftRuleConfig === "function"
      ? rulesApi.loadDraftRuleConfig
      : () => null;
  const loadActiveRuleConfig =
    typeof rulesApi.loadActiveRuleConfig === "function"
      ? rulesApi.loadActiveRuleConfig
      : () => null;
  const createBlankRuleConfig =
    typeof rulesApi.createBlankRuleConfig === "function"
      ? rulesApi.createBlankRuleConfig
      : () => ({
          version: 1,
          vowels: [],
          consonants: [],
          syllablePatterns: {
            single: [],
            initial: [],
            medial: [],
            final: []
          },
          transitionRules: [],
          wordEndBans: [],
          syllableEndBans: []
        });
  const cloneRuleConfig =
    typeof rulesApi.cloneRuleConfig === "function" ? rulesApi.cloneRuleConfig : (config) => config;
  const normalizeRuleConfig =
    typeof rulesApi.normalizeRuleConfig === "function"
      ? rulesApi.normalizeRuleConfig
      : (config) => config;
  const validateRuleConfig =
    typeof rulesApi.validateRuleConfig === "function"
      ? rulesApi.validateRuleConfig
      : () => ({ isValid: true, errors: [], config: null });
  const applyDraftRuleConfig =
    typeof rulesApi.applyDraftRuleConfig === "function"
      ? rulesApi.applyDraftRuleConfig
      : (config) => ({
          draft: config,
          active: config,
          validation: { isValid: true, errors: [], config },
          applied: true
        });
  const restoreDefaultRuleConfig =
    typeof rulesApi.restoreDefaultRuleConfig === "function"
      ? rulesApi.restoreDefaultRuleConfig
      : () => createBlankRuleConfig();

  const storageKeys =
    rulesApi.storageKeys && typeof rulesApi.storageKeys === "object" ? rulesApi.storageKeys : {};
  const draftStorageKey = typeof storageKeys.draft === "string" ? storageKeys.draft : "";
  const activeStorageKey = typeof storageKeys.active === "string" ? storageKeys.active : "";

  const app = document.querySelector(".app-settings");
  const importRulesBtn = document.getElementById("importRulesBtn");
  const exportRulesBtn = document.getElementById("exportRulesBtn");
  const blankSlateBtn = document.getElementById("blankSlateBtn");
  const restoreDefaultsBtn = document.getElementById("restoreDefaultsBtn");
  const importRulesInput = document.getElementById("importRulesInput");
  const applyStatus = document.getElementById("settingsApplyStatus");
  const importStatus = document.getElementById("settingsImportStatus");
  const errorList = document.getElementById("settingsErrorList");
  const vowelsList = document.getElementById("vowelsList");
  const consonantsList = document.getElementById("consonantsList");
  const syllablePatternsGrid = document.getElementById("syllablePatternsGrid");
  const transitionRulesList = document.getElementById("transitionRulesList");
  const syllableEndBansList = document.getElementById("syllableEndBansList");
  const wordEndBansList = document.getElementById("wordEndBansList");
  const knownRuleSymbols = document.getElementById("knownRuleSymbols");

  let draftConfig = cloneRuleConfig(loadDraftRuleConfig());
  let activeConfig = cloneRuleConfig(loadActiveRuleConfig());
  let draftValidation = validateRuleConfig(draftConfig);
  let importFeedbackMessage = "";
  let importFeedbackIsError = false;
  let pendingDeleteKey = "";

  function capitalizeLabel(value) {
    const normalizedValue = trimOrEmpty(value);
    if (!normalizedValue) {
      return "";
    }

    return normalizedValue.charAt(0).toUpperCase() + normalizedValue.slice(1);
  }

  function getPatternLabel(key) {
    switch (key) {
      case "single":
        return "Single-syllable";
      case "initial":
        return "Initial";
      case "medial":
        return "Medial";
      case "final":
        return "Final";
      default:
        return capitalizeLabel(key);
    }
  }

  function getEmptyMessage(sectionKey) {
    switch (sectionKey) {
      case "vowels":
        return "No vowels yet.";
      case "consonants":
        return "No consonants yet.";
      case "transitionRules":
        return "No transition rules yet.";
      case "syllableEndBans":
        return "No syllable-end bans yet.";
      case "wordEndBans":
        return "No word-end bans yet.";
      default:
        return "No rules yet.";
    }
  }

  function buildDeleteKey({ kind, section = "", patternKey = "", index }) {
    return [trimOrEmpty(kind), trimOrEmpty(section), trimOrEmpty(patternKey), String(index)].join("|");
  }

  function getDeleteKeyFromButton(button) {
    if (!button) {
      return "";
    }

    return buildDeleteKey({
      kind: button.dataset.kind,
      section: button.dataset.section,
      patternKey: button.dataset.patternKey,
      index: button.dataset.index
    });
  }

  function getDeleteButtonText(isPendingDelete) {
    return isPendingDelete ? "Confirm delete" : "Delete row";
  }

  function renderDeleteButton({ kind, section = "", patternKey = "", index }) {
    const deleteKey = buildDeleteKey({ kind, section, patternKey, index });
    const isPendingDelete = pendingDeleteKey === deleteKey;

    return `
      <button
        class="settings-delete-btn${isPendingDelete ? " is-pending-delete" : ""}"
        type="button"
        data-action="delete-row"
        data-kind="${escapeHtml(kind)}"
        ${section ? `data-section="${escapeHtml(section)}"` : ""}
        ${patternKey ? `data-pattern-key="${escapeHtml(patternKey)}"` : ""}
        data-index="${index}"
        data-delete-key="${escapeHtml(deleteKey)}"
        aria-label="${getDeleteButtonText(isPendingDelete)}"
        title="${getDeleteButtonText(isPendingDelete)}"
      ></button>
    `;
  }

  function syncPendingDeleteButtons() {
    if (!app) {
      return;
    }

    const buttons = app.querySelectorAll(".settings-delete-btn[data-delete-key]");
    for (const button of buttons) {
      const buttonKey = trimOrEmpty(button.dataset.deleteKey);
      const isPendingDelete = Boolean(buttonKey) && buttonKey === pendingDeleteKey;
      const label = getDeleteButtonText(isPendingDelete);
      button.classList.toggle("is-pending-delete", isPendingDelete);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  }

  function clearPendingDeleteState() {
    if (!pendingDeleteKey) {
      return;
    }

    pendingDeleteKey = "";
    syncPendingDeleteButtons();
  }

  function getKnownSymbols() {
    const normalizedDraft = normalizeRuleConfig(draftConfig);
    const symbols = [];
    const seen = new Set();

    for (const entry of [...normalizedDraft.vowels, ...normalizedDraft.consonants]) {
      if (!entry.symbol || seen.has(entry.symbol)) {
        continue;
      }

      seen.add(entry.symbol);
      symbols.push(entry.symbol);
    }

    return symbols.sort((a, b) => a.localeCompare(b));
  }

  function renderKnownSymbolOptions() {
    if (!knownRuleSymbols) {
      return;
    }

    const optionsHtml = getKnownSymbols()
      .map((symbol) => `<option value="${escapeHtml(symbol)}"></option>`)
      .join("");

    knownRuleSymbols.innerHTML = optionsHtml;
  }

  function renderInventoryList(sectionKey, container) {
    const entries = Array.isArray(draftConfig[sectionKey]) ? draftConfig[sectionKey] : [];
    if (!container) {
      return;
    }

    if (entries.length === 0) {
      container.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage(sectionKey))}</p>`;
      return;
    }

    container.innerHTML = entries
      .map(
        (entry, index) => `
          <div class="rule-row rule-row-symbol" data-kind="inventory" data-section="${sectionKey}" data-index="${index}">
            <label class="settings-field-group">
              <span class="settings-field-label">Symbol</span>
              <input
                class="settings-field"
                type="text"
                value="${escapeHtml(entry.symbol || "")}"
                data-kind="inventory"
                data-section="${sectionKey}"
                data-index="${index}"
                data-field="symbol"
                autocomplete="off"
              >
            </label>
            <label class="settings-field-group">
              <span class="settings-field-label">IPA</span>
              <input
                class="settings-field"
                type="text"
                value="${escapeHtml(entry.ipa || "")}"
                data-kind="inventory"
                data-section="${sectionKey}"
                data-index="${index}"
                data-field="ipa"
                autocomplete="off"
              >
            </label>
            ${renderDeleteButton({
              kind: "inventory",
              section: sectionKey,
              index
            })}
          </div>
        `
      )
      .join("");
  }

  function renderPatternGrid() {
    if (!syllablePatternsGrid) {
      return;
    }

    syllablePatternsGrid.innerHTML = SYLLABLE_PATTERN_KEYS.map((key) => {
      const patterns =
        draftConfig.syllablePatterns && Array.isArray(draftConfig.syllablePatterns[key])
          ? draftConfig.syllablePatterns[key]
          : [];
      const rowsHtml =
        patterns.length === 0
          ? `<p class="settings-empty">No ${escapeHtml(getPatternLabel(key).toLowerCase())} patterns yet.</p>`
          : patterns
              .map(
                (pattern, index) => `
                  <div class="rule-row rule-row-pattern" data-kind="pattern" data-pattern-key="${key}" data-index="${index}">
                    <label class="settings-field-group">
                      <span class="settings-field-label">Pattern</span>
                      <input
                        class="settings-field"
                        type="text"
                        value="${escapeHtml(pattern || "")}"
                        data-kind="pattern"
                        data-pattern-key="${key}"
                        data-index="${index}"
                        autocomplete="off"
                        spellcheck="false"
                      >
                    </label>
                    ${renderDeleteButton({
                      kind: "pattern",
                      patternKey: key,
                      index
                    })}
                  </div>
                `
              )
              .join("");

      return `
        <div class="settings-pattern-card">
          <div class="settings-subsection-header">
            <h3>${escapeHtml(getPatternLabel(key))}</h3>
          </div>
          <p class="settings-pattern-help">Use only C and V tokens.</p>
          <div class="rule-list">${rowsHtml}</div>
          <div class="settings-list-footer">
            <button class="settings-link-btn" type="button" data-action="add-pattern" data-pattern-key="${key}">Add pattern</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderTransitionRules() {
    const rules = Array.isArray(draftConfig.transitionRules) ? draftConfig.transitionRules : [];
    if (!transitionRulesList) {
      return;
    }

    if (rules.length === 0) {
      transitionRulesList.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage("transitionRules"))}</p>`;
      return;
    }

    transitionRulesList.innerHTML = rules
      .map((rule, index) => {
        const blockedValue = Array.isArray(rule.blockedNextSymbols)
          ? rule.blockedNextSymbols.join(", ")
          : "";

        return `
          <div class="rule-row rule-row-transition" data-kind="transition" data-index="${index}">
            <label class="settings-field-group">
              <span class="settings-field-label">Scope</span>
              <select class="settings-field" data-kind="transition" data-index="${index}" data-field="scope">
                ${TRANSITION_SCOPES.map(
                  (scope) => `
                    <option value="${scope}"${rule.scope === scope ? " selected" : ""}>${escapeHtml(capitalizeLabel(scope))}</option>
                  `
                ).join("")}
              </select>
            </label>
            <label class="settings-field-group">
              <span class="settings-field-label">Trigger</span>
              <input
                class="settings-field"
                type="text"
                value="${escapeHtml(rule.triggerSymbol || "")}"
                data-kind="transition"
                data-index="${index}"
                data-field="triggerSymbol"
                list="knownRuleSymbols"
                autocomplete="off"
              >
            </label>
            <label class="settings-field-group settings-field-group-wide">
              <span class="settings-field-label">Blocked next symbols</span>
              <input
                class="settings-field"
                type="text"
                value="${escapeHtml(blockedValue)}"
                data-kind="transition"
                data-index="${index}"
                data-field="blockedNextSymbols"
                list="knownRuleSymbols"
                autocomplete="off"
              >
            </label>
            ${renderDeleteButton({
              kind: "transition",
              index
            })}
          </div>
        `;
      })
      .join("");
  }

  function renderBanList(sectionKey, container) {
    const bans = Array.isArray(draftConfig[sectionKey]) ? draftConfig[sectionKey] : [];
    if (!container) {
      return;
    }

    if (bans.length === 0) {
      container.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage(sectionKey))}</p>`;
      return;
    }

    container.innerHTML = bans
      .map(
        (symbol, index) => `
          <div class="rule-row rule-row-ban" data-kind="ban" data-section="${sectionKey}" data-index="${index}">
            <label class="settings-field-group settings-field-group-wide">
              <span class="settings-field-label">Symbol</span>
              <input
                class="settings-field"
                type="text"
                value="${escapeHtml(symbol || "")}"
                data-kind="ban"
                data-section="${sectionKey}"
                data-index="${index}"
                list="knownRuleSymbols"
                autocomplete="off"
              >
            </label>
            ${renderDeleteButton({
              kind: "ban",
              section: sectionKey,
              index
            })}
          </div>
        `
      )
      .join("");
  }

  function renderStatus() {
    if (applyStatus) {
      applyStatus.textContent = draftValidation.isValid
        ? "Draft applied locally. Future generations will use these rules."
        : "Draft saved locally but not applied. The generator is still using the last valid rules.";
      applyStatus.classList.toggle("is-error", !draftValidation.isValid);
      applyStatus.classList.toggle("is-success", draftValidation.isValid);
    }

    if (errorList) {
      errorList.innerHTML = draftValidation.errors
        .map((error) => `<li>${escapeHtml(error)}</li>`)
        .join("");
      errorList.classList.toggle("is-hidden", draftValidation.errors.length === 0);
    }

    if (importStatus) {
      importStatus.textContent = importFeedbackMessage;
      importStatus.classList.toggle("is-hidden", !hasVisibleText(importFeedbackMessage));
      importStatus.classList.toggle("is-error", importFeedbackIsError);
      importStatus.classList.toggle(
        "is-success",
        hasVisibleText(importFeedbackMessage) && !importFeedbackIsError
      );
    }
  }

  function hasVisibleText(value) {
    return trimOrEmpty(value).length > 0;
  }

  function renderAll() {
    renderInventoryList("vowels", vowelsList);
    renderInventoryList("consonants", consonantsList);
    renderPatternGrid();
    renderTransitionRules();
    renderBanList("syllableEndBans", syllableEndBansList);
    renderBanList("wordEndBans", wordEndBansList);
    renderKnownSymbolOptions();
    renderStatus();
  }

  function persistDraftState() {
    const result = applyDraftRuleConfig(draftConfig);
    draftConfig = cloneRuleConfig(result.draft);
    activeConfig = cloneRuleConfig(result.active);
    draftValidation = result.validation;
    renderKnownSymbolOptions();
    renderStatus();
  }

  function persistDraftAndRender() {
    persistDraftState();
    renderAll();
  }

  function pushBlankRow(sectionKey) {
    if (sectionKey === "transitionRules") {
      draftConfig.transitionRules.push({
        scope: TRANSITION_SCOPES[0],
        triggerSymbol: "",
        blockedNextSymbols: [""]
      });
      return;
    }

    if (sectionKey === "vowels" || sectionKey === "consonants") {
      draftConfig[sectionKey].push({ symbol: "", ipa: "" });
      return;
    }

    if (sectionKey === "syllableEndBans" || sectionKey === "wordEndBans") {
      draftConfig[sectionKey].push("");
    }
  }

  function pushBlankPattern(patternKey) {
    if (!draftConfig.syllablePatterns || !Array.isArray(draftConfig.syllablePatterns[patternKey])) {
      draftConfig.syllablePatterns[patternKey] = [];
    }

    draftConfig.syllablePatterns[patternKey].push("");
  }

  function deleteRow(button) {
    const kind = trimOrEmpty(button.dataset.kind);
    const index = Number(button.dataset.index);
    if (!Number.isInteger(index) || index < 0) {
      return;
    }

    if (kind === "inventory" || kind === "ban") {
      const sectionKey = trimOrEmpty(button.dataset.section);
      if (Array.isArray(draftConfig[sectionKey])) {
        draftConfig[sectionKey].splice(index, 1);
      }
      return;
    }

    if (kind === "pattern") {
      const patternKey = trimOrEmpty(button.dataset.patternKey);
      if (
        draftConfig.syllablePatterns &&
        Array.isArray(draftConfig.syllablePatterns[patternKey])
      ) {
        draftConfig.syllablePatterns[patternKey].splice(index, 1);
      }
      return;
    }

    if (kind === "transition" && Array.isArray(draftConfig.transitionRules)) {
      draftConfig.transitionRules.splice(index, 1);
    }
  }

  function parseBlockedSymbolInput(value) {
    const parts = String(value).split(",").map((part) => trimOrEmpty(part));
    return parts.length === 0 ? [""] : parts;
  }

  function updateDraftFromField(field) {
    const kind = trimOrEmpty(field.dataset.kind);
    const index = Number(field.dataset.index);
    if (!Number.isInteger(index) || index < 0) {
      return;
    }

    if (kind === "inventory") {
      const sectionKey = trimOrEmpty(field.dataset.section);
      const propertyName = trimOrEmpty(field.dataset.field);
      if (
        Array.isArray(draftConfig[sectionKey]) &&
        draftConfig[sectionKey][index] &&
        typeof draftConfig[sectionKey][index] === "object"
      ) {
        draftConfig[sectionKey][index][propertyName] = field.value;
      }
      return;
    }

    if (kind === "pattern") {
      const patternKey = trimOrEmpty(field.dataset.patternKey);
      if (
        draftConfig.syllablePatterns &&
        Array.isArray(draftConfig.syllablePatterns[patternKey])
      ) {
        draftConfig.syllablePatterns[patternKey][index] = field.value;
      }
      return;
    }

    if (kind === "transition") {
      const propertyName = trimOrEmpty(field.dataset.field);
      const rule = draftConfig.transitionRules[index];
      if (!rule) {
        return;
      }

      if (propertyName === "blockedNextSymbols") {
        rule.blockedNextSymbols = parseBlockedSymbolInput(field.value);
      } else {
        rule[propertyName] = field.value;
      }
      return;
    }

    if (kind === "ban") {
      const sectionKey = trimOrEmpty(field.dataset.section);
      if (Array.isArray(draftConfig[sectionKey])) {
        draftConfig[sectionKey][index] = field.value;
      }
    }
  }

  async function handleImportRules() {
    if (!importRulesInput) {
      return;
    }

    const file = importRulesInput.files && importRulesInput.files[0];
    if (!file) {
      return;
    }

    try {
      const fileText = await file.text();
      const importedConfig = normalizeRuleConfig(JSON.parse(fileText));
      draftConfig = cloneRuleConfig(importedConfig);
      const result = applyDraftRuleConfig(draftConfig);
      draftConfig = cloneRuleConfig(result.draft);
      activeConfig = cloneRuleConfig(result.active);
      draftValidation = result.validation;
      importFeedbackIsError = !result.applied;
      importFeedbackMessage = result.applied
        ? `Imported rules from ${file.name}.`
        : `Imported rules from ${file.name}, but the draft has validation errors and was not applied.`;
      renderAll();
    } catch (error) {
      importFeedbackIsError = true;
      importFeedbackMessage = `Could not import rules from ${file.name}.`;
      renderStatus();
      console.error("Failed to import rule config.", error);
    } finally {
      importRulesInput.value = "";
    }
  }

  function handleExportRules() {
    const configToExport = normalizeRuleConfig(draftConfig);
    const json = JSON.stringify(configToExport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "xo-generator-rules.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);

    importFeedbackIsError = false;
    importFeedbackMessage = "Exported the current draft rules.";
    renderStatus();
  }

  function handleBlankSlate() {
    draftConfig = createBlankRuleConfig();
    activeConfig = cloneRuleConfig(loadActiveRuleConfig());
    importFeedbackIsError = false;
    importFeedbackMessage = "Saved a blank draft. Add valid rules to apply it.";
    persistDraftAndRender();
  }

  function handleRestoreDefaults() {
    const restoredConfig = restoreDefaultRuleConfig();
    draftConfig = cloneRuleConfig(restoredConfig);
    activeConfig = cloneRuleConfig(restoredConfig);
    draftValidation = validateRuleConfig(draftConfig);
    importFeedbackIsError = false;
    importFeedbackMessage = "Restored the default generator rules.";
    renderAll();
  }

  function handleClick(event) {
    const deleteButton = event.target.closest(".settings-delete-btn[data-action='delete-row']");
    if (deleteButton) {
      const deleteKey = getDeleteKeyFromButton(deleteButton);
      if (!deleteKey) {
        return;
      }

      if (pendingDeleteKey === deleteKey) {
        deleteRow(deleteButton);
        pendingDeleteKey = "";
        importFeedbackMessage = "";
        importFeedbackIsError = false;
        persistDraftAndRender();
        return;
      }

      pendingDeleteKey = deleteKey;
      syncPendingDeleteButtons();
      return;
    }

    if (pendingDeleteKey) {
      clearPendingDeleteState();
      return;
    }

    const actionButton = event.target.closest("[data-action], [data-add-section]");
    if (!actionButton) {
      return;
    }

    const action = trimOrEmpty(actionButton.dataset.action);
    const addSection = trimOrEmpty(actionButton.dataset.addSection);

    if (addSection) {
      pushBlankRow(addSection);
      importFeedbackMessage = "";
      importFeedbackIsError = false;
      persistDraftAndRender();
      return;
    }

    if (action === "add-pattern") {
      pushBlankPattern(trimOrEmpty(actionButton.dataset.patternKey));
      importFeedbackMessage = "";
      importFeedbackIsError = false;
      persistDraftAndRender();
      return;
    }

    if (action === "delete-row") {
      deleteRow(actionButton);
      importFeedbackMessage = "";
      importFeedbackIsError = false;
      persistDraftAndRender();
    }
  }

  function handleInput(event) {
    const field = event.target.closest("[data-kind]");
    if (!field || field.matches("button")) {
      return;
    }

    clearPendingDeleteState();
    updateDraftFromField(field);
    persistDraftState();
  }

  function handleFocusIn(event) {
    if (!pendingDeleteKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      clearPendingDeleteState();
      return;
    }

    if (!target.closest(".settings-delete-btn[data-action='delete-row']")) {
      clearPendingDeleteState();
    }
  }

  function handleDocumentClick(event) {
    if (!pendingDeleteKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      clearPendingDeleteState();
      return;
    }

    if (!app || !app.contains(target)) {
      clearPendingDeleteState();
    }
  }

  function handleStorageSync(event) {
    if (!event || (event.key !== draftStorageKey && event.key !== activeStorageKey)) {
      return;
    }

    draftConfig = cloneRuleConfig(loadDraftRuleConfig());
    activeConfig = cloneRuleConfig(loadActiveRuleConfig());
    draftValidation = validateRuleConfig(draftConfig);
    importFeedbackMessage = "Rules updated in another tab.";
    importFeedbackIsError = false;
    renderAll();
  }

  if (app) {
    app.addEventListener("click", handleClick);
    app.addEventListener("input", handleInput);
    app.addEventListener("change", handleInput);
    app.addEventListener("focusin", handleFocusIn);
  }

  if (importRulesBtn && importRulesInput) {
    importRulesBtn.addEventListener("click", () => {
      importRulesInput.click();
    });
    importRulesInput.addEventListener("change", () => {
      void handleImportRules();
    });
  }

  if (exportRulesBtn) {
    exportRulesBtn.addEventListener("click", handleExportRules);
  }

  if (blankSlateBtn) {
    blankSlateBtn.addEventListener("click", handleBlankSlate);
  }

  if (restoreDefaultsBtn) {
    restoreDefaultsBtn.addEventListener("click", handleRestoreDefaults);
  }

  globalScope.addEventListener("storage", handleStorageSync);
  document.addEventListener("click", handleDocumentClick);
  renderAll();
})(window);
