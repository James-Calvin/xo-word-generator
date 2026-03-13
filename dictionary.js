const COPY_FEEDBACK_MS = 1200;
const DICTIONARY_BATCH_SIZE = 30;

const FILTERS = {
  DEFINED: "defined",
  UNDEFINED: "undefined",
  ALL: "all"
};

const GROUP_CLASSIFICATIONS = {
  DEFINED: "defined",
  UNDEFINED: "undefined",
  MIXED: "mixed"
};

const EMPTY_STATUS_BY_FILTER = {
  [FILTERS.DEFINED]: "No defined words yet.",
  [FILTERS.UNDEFINED]: "No undefined saved words yet.",
  [FILTERS.ALL]: "No saved words yet."
};

const dictionaryFilters = document.getElementById("dictionaryFilters");
const myHeartsToggle = document.getElementById("dictionaryMyHeartsToggle");
const dictionaryList = document.getElementById("dictionaryList");
const dictionaryStatus = document.getElementById("dictionaryStatus");
const dictionarySentinel = document.getElementById("dictionarySentinel");
const filterButtons = dictionaryFilters
  ? Array.from(dictionaryFilters.querySelectorAll(".dictionary-filter-btn[data-filter]"))
  : [];

const entriesById = new Map();
const audioCache = new Map();
const copyFeedbackTimers = new Map();
const sharedAudio = new Audio();

let groups = [];
let visibleGroups = [];
let activeFilter = FILTERS.DEFINED;
let currentUserId = "";
let showOnlyMyHearts = false;
let selectedEntryId = null;
let playingEntryId = null;
let renderedGroupCount = 0;
let observer = null;

const sharedApi = window.LOVE_LANGUAGE_SHARED || {};
const sharedUtils = sharedApi.utils || {};
const sharedUi = sharedApi.ui || {};
const awsHelpers = window.LOVE_LANGUAGE_AWS || {};

const trimOrEmpty =
  typeof sharedUtils.trimOrEmpty === "function"
    ? sharedUtils.trimOrEmpty
    : (value) => (typeof value === "string" ? value.trim() : "");
const hasMeaningText =
  typeof sharedUtils.hasMeaningText === "function"
    ? sharedUtils.hasMeaningText
    : (value) => typeof value === "string" && value.trim().length > 0;
const toEpochMs =
  typeof sharedUtils.toEpochMs === "function"
    ? sharedUtils.toEpochMs
    : (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
const createRowId =
  typeof sharedUtils.createRowId === "function"
    ? sharedUtils.createRowId
    : () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const escapeXml =
  typeof sharedUtils.escapeXml === "function"
    ? sharedUtils.escapeXml
    : (text) =>
        String(text)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&apos;");
const toAudioBlob =
  typeof sharedUtils.toAudioBlob === "function"
    ? sharedUtils.toAudioBlob
    : () => null;
const createActionButton =
  typeof sharedUi.createActionButton === "function"
    ? sharedUi.createActionButton
    : (className, icon, label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `action-btn ${className}`;
        button.dataset.icon = icon;
        button.dataset.action = action;
        button.textContent = icon;
        button.setAttribute("aria-label", label);
        return button;
      };
const copyTextToClipboard =
  typeof sharedUi.copyTextToClipboard === "function"
    ? sharedUi.copyTextToClipboard
    : async () => {};
const buildCopyPayload =
  typeof sharedUi.buildCopyPayload === "function"
    ? sharedUi.buildCopyPayload
    : ({ word, pronunciation, ipa, meaning }) => {
        const normalizedWord = trimOrEmpty(word);
        const normalizedPronunciation = trimOrEmpty(pronunciation) || trimOrEmpty(ipa);
        const normalizedMeaning = trimOrEmpty(meaning);
        const base = `${normalizedWord} /${normalizedPronunciation}/`;
        return normalizedMeaning ? `${base} : ${normalizedMeaning}` : base;
      };

function hasDefinedMeaning(entry) {
  return hasMeaningText(entry && entry.meaning);
}

function matchesCurrentUserEntry(entry) {
  return Boolean(currentUserId) && Boolean(entry) && trimOrEmpty(entry.user) === currentUserId;
}

function getEntryActivityTimestamp(entry) {
  return Math.max(toEpochMs(entry.updatedTimestamp), toEpochMs(entry.timestamp));
}

function buildEntryId(rowId, timestamp) {
  return `${rowId}|${timestamp}`;
}

function isValidFilter(filter) {
  return filter === FILTERS.DEFINED || filter === FILTERS.UNDEFINED || filter === FILTERS.ALL;
}

function getEmptyStatusMessage(filter = activeFilter) {
  return EMPTY_STATUS_BY_FILTER[filter] || EMPTY_STATUS_BY_FILTER[FILTERS.DEFINED];
}

function getGroupStatusLabel(classification) {
  if (classification === GROUP_CLASSIFICATIONS.MIXED) {
    return "Mixed";
  }

  if (classification === GROUP_CLASSIFICATIONS.UNDEFINED) {
    return "Undefined";
  }

  return "Defined";
}

const normalizedAwsConfig =
  typeof awsHelpers.normalizeConfig === "function"
    ? awsHelpers.normalizeConfig(window.LOVE_LANGUAGE_AWS_CONFIG)
    : window.LOVE_LANGUAGE_AWS_CONFIG;
const awsRuntime =
  typeof sharedApi.createAwsRuntime === "function"
    ? sharedApi.createAwsRuntime({ awsConfig: normalizedAwsConfig })
    : null;

const awsConfig = (awsRuntime && awsRuntime.awsConfig) || normalizedAwsConfig || {};
const isPlaybackConfigured = Boolean(awsRuntime && awsRuntime.isPlaybackConfigured);
const isDictionaryConfigured = Boolean(awsRuntime && awsRuntime.isHeartsConfigured);

const getPollyClient =
  (awsRuntime && awsRuntime.getPollyClient) ||
  (() => null);
const getHeartsTableClient =
  (awsRuntime && awsRuntime.getHeartsTableClient) ||
  (() => null);
const ensureAwsCredentials =
  (awsRuntime && awsRuntime.ensureAwsCredentials) ||
  (() => Promise.resolve(false));
const getIdentityId =
  (awsRuntime && awsRuntime.getIdentityId) ||
  (async () => {
    throw new Error("AWS runtime is unavailable.");
  });

async function ensureCurrentUserIdentity() {
  if (currentUserId) {
    return currentUserId;
  }

  const resolvedIdentity = trimOrEmpty(await getIdentityId());
  if (!resolvedIdentity) {
    throw new Error("Could not resolve the current AWS identity.");
  }

  currentUserId = resolvedIdentity;
  return currentUserId;
}

function setStatus(message, type = "info") {
  if (!dictionaryStatus) {
    return;
  }

  const normalized = trimOrEmpty(message);
  dictionaryStatus.classList.remove("is-hidden", "is-error");

  if (!normalized) {
    dictionaryStatus.textContent = "";
    dictionaryStatus.classList.add("is-hidden");
    return;
  }

  dictionaryStatus.textContent = normalized;
  if (type === "error") {
    dictionaryStatus.classList.add("is-error");
  }
}

function getFilterCounts() {
  const sourceGroups = showOnlyMyHearts ? groups.filter((group) => group.hasCurrentUserHeart) : groups;
  let definedCount = 0;
  let undefinedCount = 0;

  for (const group of sourceGroups) {
    if (group.classification === GROUP_CLASSIFICATIONS.UNDEFINED) {
      undefinedCount += 1;
    } else {
      definedCount += 1;
    }
  }

  return {
    [FILTERS.DEFINED]: definedCount,
    [FILTERS.UNDEFINED]: undefinedCount,
    [FILTERS.ALL]: sourceGroups.length
  };
}

function updateFilterControls() {
  const counts = getFilterCounts();

  for (const button of filterButtons) {
    const filter = button.dataset.filter;
    const isActive = filter === activeFilter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");

    const count = button.querySelector(".dictionary-filter-count");
    if (count) {
      count.textContent = String(counts[filter] || 0);
    }
  }

  if (myHeartsToggle) {
    myHeartsToggle.classList.toggle("is-active", showOnlyMyHearts);
    myHeartsToggle.setAttribute("aria-pressed", showOnlyMyHearts ? "true" : "false");
  }
}

function updateSentinelVisibility() {
  if (!dictionarySentinel) {
    return;
  }

  const hide = visibleGroups.length === 0 || renderedGroupCount >= visibleGroups.length;
  dictionarySentinel.classList.toggle("is-hidden", hide);
}

function normalizeDictionaryEntry(rawItem) {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return null;
  }

  const rowId = trimOrEmpty(rawItem.rowId);
  const word = trimOrEmpty(rawItem.word);
  const pronunciation = trimOrEmpty(rawItem.pronunciation || rawItem.ipa);
  const hearted = Boolean(rawItem.hearted);

  if (!rowId || !word || !pronunciation || !hearted) {
    return null;
  }

  const timestamp = toEpochMs(rawItem.timestamp) || Date.now();
  const updatedTimestamp = toEpochMs(rawItem.updatedTimestamp) || timestamp;
  const rawUnheartedTimestamp = toEpochMs(rawItem.unheartedTimestamp);

  return {
    id: buildEntryId(rowId, timestamp),
    rowId,
    timestamp,
    updatedTimestamp,
    unheartedTimestamp: rawUnheartedTimestamp > 0 ? rawUnheartedTimestamp : null,
    user: trimOrEmpty(rawItem.user),
    word,
    pronunciation,
    meaning: trimOrEmpty(rawItem.meaning),
    hearted: true,
    draftMeaning: "",
    hasDraftCache: false,
    isEditing: false,
    saveStatus: "idle",
    copyFlash: false
  };
}

function buildDictionaryTableItem(entry) {
  return {
    rowId: entry.rowId,
    timestamp: entry.timestamp,
    user: entry.user || null,
    word: entry.word,
    pronunciation: entry.pronunciation,
    meaning: entry.meaning || null,
    hearted: Boolean(entry.hearted),
    updatedTimestamp: entry.updatedTimestamp,
    unheartedTimestamp: entry.unheartedTimestamp ?? null
  };
}

async function scanHeartedEntries() {
  const currentHeartsClient = getHeartsTableClient();
  if (!currentHeartsClient) {
    return [];
  }

  const items = [];
  let lastEvaluatedKey = undefined;

  do {
    const response = await currentHeartsClient
      .scan({
        TableName: awsConfig.heartsTableName,
        FilterExpression: "#hearted = :hearted",
        ExpressionAttributeNames: {
          "#rowId": "rowId",
          "#word": "word",
          "#pronunciation": "pronunciation",
          "#meaning": "meaning",
          "#hearted": "hearted",
          "#timestamp": "timestamp",
          "#updatedTimestamp": "updatedTimestamp",
          "#user": "user",
          "#unheartedTimestamp": "unheartedTimestamp"
        },
        ExpressionAttributeValues: {
          ":hearted": true
        },
        ProjectionExpression:
          "#rowId, #word, #pronunciation, #meaning, #hearted, #timestamp, #updatedTimestamp, #user, #unheartedTimestamp",
        ExclusiveStartKey: lastEvaluatedKey
      })
      .promise();

    if (Array.isArray(response.Items) && response.Items.length > 0) {
      items.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

function rebuildGroupsFromEntries() {
  const expandedByWord = new Map(groups.map((group) => [group.word, group.expanded]));
  const entriesByWord = new Map();

  for (const entry of entriesById.values()) {
    if (!entry.hearted) {
      continue;
    }

    if (!entriesByWord.has(entry.word)) {
      entriesByWord.set(entry.word, []);
    }

    entriesByWord.get(entry.word).push(entry);
  }

  const nextGroups = [];
  for (const [word, wordEntries] of entriesByWord.entries()) {
    const definedEntries = [];
    const undefinedEntries = [];

    for (const entry of wordEntries) {
      if (hasDefinedMeaning(entry)) {
        definedEntries.push(entry);
      } else {
        undefinedEntries.push(entry);
      }
    }

    definedEntries.sort((left, right) => getEntryActivityTimestamp(right) - getEntryActivityTimestamp(left));
    undefinedEntries.sort(
      (left, right) => getEntryActivityTimestamp(right) - getEntryActivityTimestamp(left)
    );

    if (definedEntries.length === 0 && undefinedEntries.length === 0) {
      continue;
    }

    const classification =
      definedEntries.length > 0
        ? undefinedEntries.length > 0
          ? GROUP_CLASSIFICATIONS.MIXED
          : GROUP_CLASSIFICATIONS.DEFINED
        : GROUP_CLASSIFICATIONS.UNDEFINED;

    const latestActivityTimestamp = wordEntries.reduce(
      (maxTimestamp, entry) => Math.max(maxTimestamp, getEntryActivityTimestamp(entry)),
      0
    );

    nextGroups.push({
      word,
      definedEntries,
      undefinedEntries,
      classification,
      currentUserHeartedEntries: wordEntries.filter((entry) => matchesCurrentUserEntry(entry)),
      hasCurrentUserHeart: wordEntries.some((entry) => matchesCurrentUserEntry(entry)),
      expanded: Boolean(expandedByWord.get(word)),
      latestActivityTimestamp
    });
  }

  nextGroups.sort((left, right) => {
    const timestampDiff = right.latestActivityTimestamp - left.latestActivityTimestamp;
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return left.word.localeCompare(right.word);
  });

  groups = nextGroups;
}

function getVisibleEntriesForGroup(group) {
  if (!group) {
    return [];
  }

  if (activeFilter === FILTERS.UNDEFINED) {
    return group.undefinedEntries;
  }

  if (activeFilter === FILTERS.ALL) {
    return [...group.definedEntries, ...group.undefinedEntries];
  }

  return group.definedEntries;
}

function isGroupVisible(group) {
  if (!group) {
    return false;
  }

  if (showOnlyMyHearts && !group.hasCurrentUserHeart) {
    return false;
  }

  if (activeFilter === FILTERS.UNDEFINED) {
    return group.classification === GROUP_CLASSIFICATIONS.UNDEFINED;
  }

  if (activeFilter === FILTERS.ALL) {
    return true;
  }

  return group.classification !== GROUP_CLASSIFICATIONS.UNDEFINED;
}

function rebuildVisibleGroups() {
  visibleGroups = groups.filter((group) => isGroupVisible(group) && getVisibleEntriesForGroup(group).length > 0);
  updateFilterControls();
}

function getEntryRow(entryId) {
  if (!dictionaryList) {
    return null;
  }

  const rows = dictionaryList.querySelectorAll(".dictionary-entry");
  for (const row of rows) {
    if (row.dataset.entryId === entryId) {
      return row;
    }
  }

  return null;
}

function renderEntryMeaning(row, entry) {
  const container = row.querySelector(".row-meaning");
  if (!container) {
    return;
  }

  container.textContent = "";
  const isSelected = selectedEntryId === entry.id;
  const isSaving = entry.saveStatus !== "idle";
  const hasMeaning = hasDefinedMeaning(entry);

  if (hasMeaning) {
    const definition = document.createElement("span");
    definition.className = "meaning-definition";
    definition.textContent = `— ${entry.meaning}`;
    container.appendChild(definition);
  }

  if (entry.isEditing && isSelected) {
    const editor = document.createElement("div");
    editor.className = "meaning-editor";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "meaning-input";
    input.placeholder = "What does this word mean?";
    input.value = entry.draftMeaning;

    const saveButton = createActionButton("meaning-action is-save", "✓", "Save meaning", "save-meaning");
    const cancelButton = createActionButton(
      "meaning-action",
      "✕",
      "Cancel meaning edit",
      "cancel-meaning"
    );

    if (isSaving) {
      input.disabled = true;
      saveButton.disabled = true;
      cancelButton.disabled = true;
    }

    editor.append(input, saveButton, cancelButton);
    container.appendChild(editor);

    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return;
  }

  if (!isSelected) {
    return;
  }

  const link = document.createElement("button");
  link.type = "button";
  link.className = "meaning-link";
  link.dataset.action = "open-meaning-editor";
  link.textContent = hasMeaning ? "Edit" : "Add a meaning";
  link.disabled = isSaving;
  container.appendChild(link);
}

function applyEntryRowState(row, entry) {
  row.classList.toggle("is-selected", selectedEntryId === entry.id);

  const heartButton = row.querySelector(".heart-btn");
  if (heartButton) {
    const group = getGroupByWord(entry.word);
    const showHeartButton = Boolean(group && group.hasCurrentUserHeart);
    heartButton.classList.toggle("is-hidden", !showHeartButton);
    heartButton.classList.toggle("is-hearted", showHeartButton);
    heartButton.textContent = "❤";
    heartButton.setAttribute("aria-label", "Remove my saved word");
    heartButton.disabled = !showHeartButton || entry.saveStatus !== "idle";
  }

  const copyButton = row.querySelector(".copy-btn");
  if (copyButton) {
    copyButton.classList.toggle("is-success", entry.copyFlash);
    copyButton.textContent = entry.copyFlash ? "✓" : copyButton.dataset.icon;
  }

  const playButton = row.querySelector(".play-btn");
  if (playButton) {
    const isPlaying = playingEntryId === entry.id;
    playButton.classList.toggle("is-playing", isPlaying);
    playButton.classList.remove("is-loading");
    playButton.textContent = isPlaying ? "■" : playButton.dataset.icon;
  }

  renderEntryMeaning(row, entry);
}

function renderEntryRow(entryId) {
  const entry = entriesById.get(entryId);
  const row = getEntryRow(entryId);
  if (!entry || !row) {
    return;
  }

  applyEntryRowState(row, entry);
}

function createEntryRowElement(entry, isHistoryEntry) {
  const row = document.createElement("div");
  row.className = "result-row dictionary-entry";
  if (isHistoryEntry) {
    row.classList.add("dictionary-history-entry");
  }

  row.dataset.entryId = entry.id;
  row.dataset.word = entry.word;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const heartButton = createActionButton("heart-btn", "❤", "Remove saved word", "toggle-heart");

  const copyButton = createActionButton("copy-btn", "⧉", "Copy word details", "copy-word");

  const playButton = createActionButton("play-btn", "▶", "Play pronunciation", "play-pronunciation");
  if (!isPlaybackConfigured) {
    playButton.classList.add("is-hidden");
  }

  actions.append(playButton, heartButton);

  const content = document.createElement("div");
  content.className = "row-content";

  const wordSpan = document.createElement("span");
  wordSpan.className = "word";
  wordSpan.textContent = entry.word;

  const ipaSpan = document.createElement("span");
  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${entry.pronunciation}/`;

  content.append(wordSpan, ipaSpan);

  const meaning = document.createElement("div");
  meaning.className = "row-meaning";

  const copySlot = document.createElement("div");
  copySlot.className = "row-copy";
  copySlot.append(copyButton);

  row.append(actions, content, meaning, copySlot);
  applyEntryRowState(row, entry);

  return row;
}

function createGroupCard(group) {
  const visibleEntries = getVisibleEntriesForGroup(group);
  if (visibleEntries.length === 0) {
    return null;
  }

  const card = document.createElement("li");
  card.className = "dictionary-card";
  card.dataset.word = group.word;

  const header = document.createElement("div");
  header.className = "dictionary-card-header";

  const wordMeta = document.createElement("div");
  wordMeta.className = "dictionary-word-meta";

  const title = document.createElement("span");
  title.className = "dictionary-word-title";
  title.textContent = group.word;

  const badge = document.createElement("span");
  badge.className = `dictionary-status-badge is-${group.classification}`;
  badge.textContent = getGroupStatusLabel(group.classification);

  wordMeta.append(title, badge);
  header.appendChild(wordMeta);

  if (visibleEntries.length > 1) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dictionary-history-toggle";
    toggle.dataset.action = "toggle-history";
    toggle.dataset.word = group.word;
    toggle.textContent = group.expanded ? "Hide history" : `Show history (${visibleEntries.length - 1})`;
    header.appendChild(toggle);
  }

  const main = document.createElement("div");
  main.className = "dictionary-main";
  main.appendChild(createEntryRowElement(visibleEntries[0], false));

  card.append(header, main);

  if (visibleEntries.length > 1) {
    const history = document.createElement("div");
    history.className = "dictionary-history";
    history.hidden = !group.expanded;

    for (let i = 1; i < visibleEntries.length; i += 1) {
      history.appendChild(createEntryRowElement(visibleEntries[i], true));
    }

    card.appendChild(history);
  }

  return card;
}

function appendGroupCards(targetCount) {
  if (!dictionaryList) {
    return;
  }

  while (renderedGroupCount < targetCount && renderedGroupCount < visibleGroups.length) {
    const group = visibleGroups[renderedGroupCount];
    const card = createGroupCard(group);
    if (card) {
      dictionaryList.appendChild(card);
    }
    renderedGroupCount += 1;
  }

  updateSentinelVisibility();
}

function renderDictionary(preserveCount = 0) {
  if (!dictionaryList) {
    return;
  }

  dictionaryList.textContent = "";
  renderedGroupCount = 0;

  if (visibleGroups.length === 0) {
    updateSentinelVisibility();
    return;
  }

  const initialCount =
    preserveCount > 0
      ? Math.min(visibleGroups.length, Math.max(DICTIONARY_BATCH_SIZE, preserveCount))
      : Math.min(visibleGroups.length, DICTIONARY_BATCH_SIZE);

  appendGroupCards(initialCount);
}

function renderNextGroupBatch() {
  if (renderedGroupCount >= visibleGroups.length) {
    updateSentinelVisibility();
    return;
  }

  const nextCount = Math.min(visibleGroups.length, renderedGroupCount + DICTIONARY_BATCH_SIZE);
  appendGroupCards(nextCount);
}

function setupObserver() {
  if (!dictionarySentinel) {
    return;
  }

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (visibleGroups.length === 0) {
    updateSentinelVisibility();
    return;
  }

  if (typeof window.IntersectionObserver !== "function") {
    appendGroupCards(visibleGroups.length);
    return;
  }

  observer = new window.IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      renderNextGroupBatch();
    },
    {
      root: null,
      rootMargin: "240px 0px"
    }
  );

  observer.observe(dictionarySentinel);
}

function clearCopyFeedback(entryId) {
  const timer = copyFeedbackTimers.get(entryId);
  if (!timer) {
    return;
  }

  window.clearTimeout(timer);
  copyFeedbackTimers.delete(entryId);
}

function showCopySuccess(entryId) {
  const entry = entriesById.get(entryId);
  if (!entry) {
    return;
  }

  clearCopyFeedback(entryId);
  entry.copyFlash = true;
  renderEntryRow(entryId);

  const timer = window.setTimeout(() => {
    const current = entriesById.get(entryId);
    if (!current) {
      return;
    }

    current.copyFlash = false;
    renderEntryRow(entryId);
    copyFeedbackTimers.delete(entryId);
  }, COPY_FEEDBACK_MS);

  copyFeedbackTimers.set(entryId, timer);
}

function isEntryVisible(entryId) {
  if (!entryId) {
    return false;
  }

  for (const group of visibleGroups) {
    const visibleEntries = getVisibleEntriesForGroup(group);
    if (visibleEntries.some((entry) => entry.id === entryId)) {
      return true;
    }
  }

  return false;
}

function setSelectedEntry(entryId) {
  if (!entryId || selectedEntryId === entryId) {
    return;
  }

  const previous = selectedEntryId;
  selectedEntryId = entryId;

  if (playingEntryId && playingEntryId !== entryId) {
    stopAudio();
  }

  if (previous) {
    renderEntryRow(previous);
  }

  renderEntryRow(entryId);
}

function clearSelection() {
  if (!selectedEntryId) {
    return;
  }

  const previous = selectedEntryId;
  selectedEntryId = null;
  renderEntryRow(previous);
}

function clearPlayState() {
  if (!playingEntryId) {
    return;
  }

  const previous = playingEntryId;
  playingEntryId = null;
  renderEntryRow(previous);
}

function stopAudio() {
  sharedAudio.pause();
  sharedAudio.currentTime = 0;
  clearPlayState();
}

function syncVisibleState(preferredEntryId = "") {
  if (playingEntryId && !isEntryVisible(playingEntryId)) {
    stopAudio();
  }

  if (preferredEntryId && isEntryVisible(preferredEntryId)) {
    if (selectedEntryId !== preferredEntryId) {
      setSelectedEntry(preferredEntryId);
    }
    return;
  }

  if (selectedEntryId && !isEntryVisible(selectedEntryId)) {
    selectedEntryId = null;
  }
}

function refreshDictionaryView(options = {}) {
  const preserveCount = Number(options.preserveCount) > 0 ? Number(options.preserveCount) : 0;
  const preferredEntryId = trimOrEmpty(options.preferredEntryId);

  rebuildVisibleGroups();

  if (!dictionaryList) {
    updateSentinelVisibility();
    return;
  }

  if (visibleGroups.length === 0) {
    dictionaryList.textContent = "";
    renderedGroupCount = 0;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    updateSentinelVisibility();
    setStatus(getEmptyStatusMessage());
    syncVisibleState();
    return;
  }

  setStatus("");
  renderDictionary(preserveCount);
  setupObserver();
  syncVisibleState(preferredEntryId);
}

async function synthesize(word, ipa) {
  const currentPollyClient = getPollyClient();
  if (!isPlaybackConfigured || !currentPollyClient) {
    return null;
  }

  const ready = await ensureAwsCredentials();
  if (!ready) {
    return null;
  }

  const cacheKey = [
    word,
    ipa,
    awsConfig.region,
    awsConfig.voiceId,
    awsConfig.engine,
    awsConfig.outputFormat
  ].join("|");

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey);
  }

  const ssml = `<speak><phoneme alphabet="ipa" ph="${escapeXml(ipa)}">${escapeXml(
    word
  )}</phoneme></speak>`;

  const data = await currentPollyClient
    .synthesizeSpeech({
      OutputFormat: awsConfig.outputFormat,
      TextType: "ssml",
      Text: ssml,
      VoiceId: awsConfig.voiceId,
      Engine: awsConfig.engine
    })
    .promise();

  const audioBlob = toAudioBlob(data.AudioStream, awsConfig.outputFormat);
  if (!audioBlob) {
    throw new Error("Polly returned an unsupported audio stream payload.");
  }

  const objectUrl = URL.createObjectURL(audioBlob);
  audioCache.set(cacheKey, objectUrl);
  return objectUrl;
}

async function playPronunciation(entryId) {
  if (!isPlaybackConfigured) {
    return;
  }

  const entry = entriesById.get(entryId);
  const row = getEntryRow(entryId);
  if (!entry || !row) {
    return;
  }

  const button = row.querySelector(".play-btn");
  if (!button || button.classList.contains("is-hidden")) {
    return;
  }

  if (playingEntryId === entryId && !sharedAudio.paused) {
    stopAudio();
    return;
  }

  if (playingEntryId && playingEntryId !== entryId) {
    stopAudio();
  }

  button.classList.add("is-loading");
  button.textContent = "...";

  try {
    const audioUrl = await synthesize(entry.word, entry.pronunciation);
    if (!audioUrl) {
      button.classList.remove("is-loading");
      button.textContent = button.dataset.icon;
      return;
    }

    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    sharedAudio.src = audioUrl;

    await sharedAudio.play();

    playingEntryId = entryId;
    renderEntryRow(entryId);
  } catch (error) {
    button.classList.remove("is-loading");
    button.textContent = button.dataset.icon;
    console.error("Failed to synthesize or play pronunciation.", error);
  }
}

function getGroupByWord(word) {
  for (const group of groups) {
    if (group.word === word) {
      return group;
    }
  }

  return null;
}

function getCardByWord(word) {
  if (!dictionaryList) {
    return null;
  }

  const cards = dictionaryList.querySelectorAll(".dictionary-card");
  for (const card of cards) {
    if (card.dataset.word === word) {
      return card;
    }
  }

  return null;
}

function toggleHistory(word) {
  const group = getGroupByWord(word);
  const visibleEntries = getVisibleEntriesForGroup(group);
  if (!group || visibleEntries.length <= 1) {
    return;
  }

  group.expanded = !group.expanded;

  const card = getCardByWord(word);
  if (!card) {
    renderDictionary(renderedGroupCount);
    syncVisibleState();
    return;
  }

  const history = card.querySelector(".dictionary-history");
  if (history) {
    history.hidden = !group.expanded;
  }

  const toggle = card.querySelector(".dictionary-history-toggle");
  if (toggle) {
    toggle.textContent = group.expanded ? "Hide history" : `Show history (${visibleEntries.length - 1})`;
  }
}

function openMeaningEditor(entryId) {
  const entry = entriesById.get(entryId);
  if (!entry) {
    return;
  }

  if (!entry.hasDraftCache) {
    entry.draftMeaning = entry.meaning;
    entry.hasDraftCache = true;
  }

  entry.isEditing = true;
  renderEntryRow(entryId);
}

function closeMeaningEditor(entryId) {
  const entry = entriesById.get(entryId);
  if (!entry) {
    return;
  }

  entry.isEditing = false;
  renderEntryRow(entryId);
}

async function putDictionaryRecord(entry) {
  const currentHeartsClient = getHeartsTableClient();
  if (!isDictionaryConfigured || !currentHeartsClient) {
    throw new Error("Dictionary persistence is not configured.");
  }

  await currentHeartsClient
    .put({
      TableName: awsConfig.heartsTableName,
      Item: buildDictionaryTableItem(entry)
    })
    .promise();
}

async function createEditedEntry(sourceEntry, newMeaning, userOverride = "", heartedOverride = true) {
  const rowId = createRowId();
  const now = Date.now();
  const resolvedUser = trimOrEmpty(userOverride) || sourceEntry.user || (await getIdentityId());

  const entry = {
    id: buildEntryId(rowId, now),
    rowId,
    timestamp: now,
    updatedTimestamp: now,
    unheartedTimestamp: null,
    user: resolvedUser,
    word: sourceEntry.word,
    pronunciation: sourceEntry.pronunciation,
    meaning: newMeaning,
    hearted: Boolean(heartedOverride),
    draftMeaning: newMeaning,
    hasDraftCache: true,
    isEditing: false,
    saveStatus: "idle",
    copyFlash: false
  };

  await putDictionaryRecord(entry);
  return entry;
}

async function handleToggleHeart(entryId) {
  const entry = entriesById.get(entryId);
  const group = entry ? getGroupByWord(entry.word) : null;
  const targetEntries =
    group && Array.isArray(group.currentUserHeartedEntries)
      ? group.currentUserHeartedEntries
          .map((groupEntry) => entriesById.get(groupEntry.id))
          .filter((groupEntry) => Boolean(groupEntry))
      : [];
  const visibleEntries = group ? getVisibleEntriesForGroup(group) : [];

  if (!entry || !isDictionaryConfigured || !group || targetEntries.length === 0) {
    return;
  }

  const previousSnapshots = targetEntries.map((targetEntry) => ({
    id: targetEntry.id,
    user: targetEntry.user,
    hearted: targetEntry.hearted,
    updatedTimestamp: targetEntry.updatedTimestamp,
    unheartedTimestamp: targetEntry.unheartedTimestamp,
    saveStatus: targetEntry.saveStatus
  }));
  const previousVisibleStatuses = visibleEntries.map((visibleEntry) => ({
    id: visibleEntry.id,
    saveStatus: visibleEntry.saveStatus
  }));

  for (const visibleEntry of visibleEntries) {
    visibleEntry.saveStatus = "saving-heart";
    renderEntryRow(visibleEntry.id);
  }

  try {
    const identityId = await ensureCurrentUserIdentity();
    const now = Date.now();

    for (const targetEntry of targetEntries) {
      targetEntry.user = targetEntry.user || identityId;
      targetEntry.hearted = false;
      targetEntry.updatedTimestamp = now;
      targetEntry.unheartedTimestamp = now;
      await putDictionaryRecord(targetEntry);
    }

    for (const targetEntry of targetEntries) {
      clearCopyFeedback(targetEntry.id);
      entriesById.delete(targetEntry.id);
    }

    for (const visibleEntry of visibleEntries) {
      const currentEntry = entriesById.get(visibleEntry.id);
      if (!currentEntry) {
        continue;
      }

      currentEntry.saveStatus = "idle";
    }

    const previousCount = renderedGroupCount;
    rebuildGroupsFromEntries();
    refreshDictionaryView({ preserveCount: previousCount });
  } catch (error) {
    for (const snapshot of previousSnapshots) {
      const targetEntry = entriesById.get(snapshot.id);
      if (!targetEntry) {
        continue;
      }

      targetEntry.user = snapshot.user;
      targetEntry.hearted = snapshot.hearted;
      targetEntry.updatedTimestamp = snapshot.updatedTimestamp;
      targetEntry.unheartedTimestamp = snapshot.unheartedTimestamp;
      targetEntry.saveStatus = snapshot.saveStatus;
    }

    for (const snapshot of previousVisibleStatuses) {
      const visibleEntry = entriesById.get(snapshot.id);
      if (!visibleEntry) {
        continue;
      }

      visibleEntry.saveStatus = snapshot.saveStatus;
      renderEntryRow(visibleEntry.id);
    }

    console.error("Failed to soft-delete current user hearted entries for word.", error);
  }
}

async function handleSaveMeaning(entryId) {
  const entry = entriesById.get(entryId);
  if (!entry || !isDictionaryConfigured) {
    return;
  }

  const trimmedMeaning = trimOrEmpty(entry.draftMeaning);
  if (!trimmedMeaning) {
    closeMeaningEditor(entryId);
    return;
  }

  const isSameUserVisibleEntry = matchesCurrentUserEntry(entry);
  const previousSnapshot = {
    meaning: entry.meaning,
    user: entry.user,
    updatedTimestamp: entry.updatedTimestamp,
    unheartedTimestamp: entry.unheartedTimestamp,
    hearted: entry.hearted,
    draftMeaning: entry.draftMeaning,
    hasDraftCache: entry.hasDraftCache,
    isEditing: entry.isEditing,
    saveStatus: entry.saveStatus
  };

  entry.isEditing = false;
  entry.saveStatus = "saving-meaning";
  renderEntryRow(entryId);

  try {
    const identityId = await ensureCurrentUserIdentity();
    const previousCount = renderedGroupCount;
    let preferredEntryId = entry.id;

    if (isSameUserVisibleEntry) {
      entry.user = identityId;
      entry.meaning = trimmedMeaning;
      entry.updatedTimestamp = Date.now();
      entry.draftMeaning = trimmedMeaning;
      entry.hasDraftCache = true;
      entry.isEditing = false;
      entry.saveStatus = "idle";
      await putDictionaryRecord(entry);
    } else {
      await createEditedEntry(entry, trimmedMeaning, identityId, false);
      entry.saveStatus = "idle";
      entry.isEditing = false;
    }

    rebuildGroupsFromEntries();
    refreshDictionaryView({ preserveCount: previousCount, preferredEntryId });
  } catch (error) {
    entry.meaning = previousSnapshot.meaning;
    entry.user = previousSnapshot.user;
    entry.updatedTimestamp = previousSnapshot.updatedTimestamp;
    entry.unheartedTimestamp = previousSnapshot.unheartedTimestamp;
    entry.hearted = previousSnapshot.hearted;
    entry.draftMeaning = previousSnapshot.draftMeaning;
    entry.hasDraftCache = previousSnapshot.hasDraftCache;
    entry.isEditing = previousSnapshot.isEditing;
    entry.saveStatus = previousSnapshot.saveStatus;
    renderEntryRow(entryId);
    console.error("Failed to save dictionary meaning.", error);
  }
}

function handleMeaningInput(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const row = input.closest(".dictionary-entry");
  if (!row) {
    return;
  }

  const entry = entriesById.get(row.dataset.entryId);
  if (!entry) {
    return;
  }

  entry.draftMeaning = input.value;
  entry.hasDraftCache = true;
}

function handleMeaningInputKeydown(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const row = input.closest(".dictionary-entry");
  if (!row) {
    return;
  }

  const entryId = row.dataset.entryId;
  if (!entryId) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void handleSaveMeaning(entryId);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeMeaningEditor(entryId);
  }
}

async function handleDictionaryListClick(event) {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (actionButton && actionButton.dataset.action === "toggle-history") {
    toggleHistory(actionButton.dataset.word || "");
    return;
  }

  const row = event.target.closest(".dictionary-entry");
  if (!row || !dictionaryList || !dictionaryList.contains(row)) {
    return;
  }

  const entryId = row.dataset.entryId;
  if (!entryId || !entriesById.has(entryId)) {
    return;
  }

  setSelectedEntry(entryId);

  if (!actionButton) {
    return;
  }

  const action = actionButton.dataset.action;

  if (action === "toggle-heart") {
    await handleToggleHeart(entryId);
    return;
  }

  if (action === "copy-word") {
    try {
      const entry = entriesById.get(entryId);
      if (!entry) {
        return;
      }

      await copyTextToClipboard(buildCopyPayload(entry));
      showCopySuccess(entryId);
    } catch (error) {
      console.error("Copy failed.", error);
    }
    return;
  }

  if (action === "play-pronunciation") {
    await playPronunciation(entryId);
    return;
  }

  if (action === "open-meaning-editor") {
    openMeaningEditor(entryId);
    return;
  }

  if (action === "save-meaning") {
    await handleSaveMeaning(entryId);
    return;
  }

  if (action === "cancel-meaning") {
    closeMeaningEditor(entryId);
  }
}

function handleFilterClick(event) {
  const button = event.target.closest(".dictionary-filter-btn[data-filter]");
  if (!button) {
    return;
  }

  const nextFilter = trimOrEmpty(button.dataset.filter);
  if (!isValidFilter(nextFilter) || nextFilter === activeFilter) {
    return;
  }

  activeFilter = nextFilter;
  refreshDictionaryView();
}

function handleMyHeartsToggleClick() {
  showOnlyMyHearts = !showOnlyMyHearts;
  refreshDictionaryView();
}

async function loadDictionary() {
  if (!dictionaryList || !dictionaryStatus) {
    return;
  }

  if (!isDictionaryConfigured) {
    setStatus("Dictionary is unavailable. Configure AWS guest access to load saved words.", "error");
    updateFilterControls();
    updateSentinelVisibility();
    return;
  }

  setStatus("Loading dictionary...");

  const ready = await ensureAwsCredentials();
  if (!ready) {
    setStatus("Could not initialize AWS guest credentials.", "error");
    updateFilterControls();
    updateSentinelVisibility();
    return;
  }

  try {
    await ensureCurrentUserIdentity();
    const rawItems = await scanHeartedEntries();

    entriesById.clear();
    for (const rawItem of rawItems) {
      const entry = normalizeDictionaryEntry(rawItem);
      if (!entry) {
        continue;
      }

      entriesById.set(entry.id, entry);
    }

    rebuildGroupsFromEntries();
    refreshDictionaryView();
  } catch (error) {
    console.error("Failed to load dictionary entries.", error);
    setStatus("Failed to load dictionary entries.", "error");
    updateFilterControls();
    updateSentinelVisibility();
  }
}

updateFilterControls();

sharedAudio.addEventListener("ended", () => clearPlayState());
sharedAudio.addEventListener("error", () => clearPlayState());

if (dictionaryFilters) {
  dictionaryFilters.addEventListener("click", handleFilterClick);
}

if (myHeartsToggle) {
  myHeartsToggle.addEventListener("click", handleMyHeartsToggleClick);
}

if (dictionaryList) {
  dictionaryList.addEventListener("click", (event) => {
    void handleDictionaryListClick(event);
  });

  dictionaryList.addEventListener("input", handleMeaningInput);
  dictionaryList.addEventListener("keydown", handleMeaningInputKeydown);
}

document.addEventListener("click", (event) => {
  if (
    event.target.closest(".dictionary-entry") ||
    event.target.closest(".dictionary-history-toggle") ||
    event.target.closest(".dictionary-filter-btn") ||
    event.target.closest(".dictionary-toggle-btn")
  ) {
    return;
  }

  clearSelection();
});

window.addEventListener("beforeunload", () => {
  stopAudio();

  for (const url of audioCache.values()) {
    URL.revokeObjectURL(url);
  }

  for (const entryId of copyFeedbackTimers.keys()) {
    clearCopyFeedback(entryId);
  }
});

void loadDictionary();
