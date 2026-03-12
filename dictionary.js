const COPY_FEEDBACK_MS = 1200;
const DICTIONARY_BATCH_SIZE = 30;

const dictionaryList = document.getElementById("dictionaryList");
const dictionaryStatus = document.getElementById("dictionaryStatus");
const dictionarySentinel = document.getElementById("dictionarySentinel");

const entriesById = new Map();
const audioCache = new Map();
const copyFeedbackTimers = new Map();
const sharedAudio = new Audio();

let groups = [];
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

function getEntryActivityTimestamp(entry) {
  return Math.max(toEpochMs(entry.updatedTimestamp), toEpochMs(entry.timestamp));
}

function buildEntryId(rowId, timestamp) {
  return `${rowId}|${timestamp}`;
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
const hasAwsSdk = Boolean(awsRuntime && awsRuntime.hasAwsSdk);
const hasDocumentClient = Boolean(awsRuntime && awsRuntime.hasDocumentClient);
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

function updateSentinelVisibility() {
  if (!dictionarySentinel) {
    return;
  }

  const hide = groups.length === 0 || renderedGroupCount >= groups.length;
  dictionarySentinel.classList.toggle("is-hidden", hide);
}

function normalizeDictionaryEntry(rawItem) {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return null;
  }

  const rowId = trimOrEmpty(rawItem.rowId);
  const word = trimOrEmpty(rawItem.word);
  const pronunciation = trimOrEmpty(rawItem.pronunciation || rawItem.ipa);
  const meaning = trimOrEmpty(rawItem.meaning);
  const hearted = Boolean(rawItem.hearted);

  if (!rowId || !word || !pronunciation || !meaning || !hearted) {
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
    meaning,
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

async function scanDefinedHeartedEntries() {
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
        FilterExpression: "#hearted = :hearted AND attribute_exists(#meaning) AND #meaning <> :empty",
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
          ":hearted": true,
          ":empty": ""
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
    if (!entry.hearted || !hasMeaningText(entry.meaning)) {
      continue;
    }

    if (!entriesByWord.has(entry.word)) {
      entriesByWord.set(entry.word, []);
    }

    entriesByWord.get(entry.word).push(entry);
  }

  const nextGroups = [];
  for (const [word, entries] of entriesByWord.entries()) {
    entries.sort((left, right) => getEntryActivityTimestamp(right) - getEntryActivityTimestamp(left));

    nextGroups.push({
      word,
      entries,
      expanded: Boolean(expandedByWord.get(word)),
      latestActivityTimestamp: entries.length > 0 ? getEntryActivityTimestamp(entries[0]) : 0
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

  const definition = document.createElement("span");
  definition.className = "meaning-definition";
  definition.textContent = `Definition: ${entry.meaning}`;
  container.appendChild(definition);

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
  link.textContent = "Edit";
  link.disabled = isSaving;
  container.appendChild(link);
}

function applyEntryRowState(row, entry) {
  row.classList.toggle("is-selected", selectedEntryId === entry.id);

  const heartButton = row.querySelector(".heart-btn");
  if (heartButton) {
    heartButton.classList.add("is-hearted");
    heartButton.textContent = "❤";
    heartButton.setAttribute("aria-label", "Remove saved word");
    heartButton.disabled = entry.saveStatus !== "idle";
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

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const heartButton = createActionButton("heart-btn", "❤", "Remove saved word", "toggle-heart");
  heartButton.classList.add("is-hearted");

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
  const card = document.createElement("li");
  card.className = "dictionary-card";
  card.dataset.word = group.word;

  const header = document.createElement("div");
  header.className = "dictionary-card-header";

  const title = document.createElement("span");
  title.className = "dictionary-word-title";
  title.textContent = group.word;

  header.appendChild(title);

  if (group.entries.length > 1) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dictionary-history-toggle";
    toggle.dataset.action = "toggle-history";
    toggle.dataset.word = group.word;
    toggle.textContent = group.expanded ? "Hide history" : `Show history (${group.entries.length - 1})`;
    header.appendChild(toggle);
  }

  const main = document.createElement("div");
  main.className = "dictionary-main";
  main.appendChild(createEntryRowElement(group.entries[0], false));

  card.append(header, main);

  if (group.entries.length > 1) {
    const history = document.createElement("div");
    history.className = "dictionary-history";
    history.hidden = !group.expanded;

    for (let i = 1; i < group.entries.length; i += 1) {
      history.appendChild(createEntryRowElement(group.entries[i], true));
    }

    card.appendChild(history);
  }

  return card;
}

function appendGroupCards(targetCount) {
  if (!dictionaryList) {
    return;
  }

  while (renderedGroupCount < targetCount && renderedGroupCount < groups.length) {
    dictionaryList.appendChild(createGroupCard(groups[renderedGroupCount]));
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

  if (groups.length === 0) {
    updateSentinelVisibility();
    return;
  }

  const initialCount =
    preserveCount > 0
      ? Math.min(groups.length, Math.max(DICTIONARY_BATCH_SIZE, preserveCount))
      : Math.min(groups.length, DICTIONARY_BATCH_SIZE);

  appendGroupCards(initialCount);
}

function renderNextGroupBatch() {
  if (renderedGroupCount >= groups.length) {
    updateSentinelVisibility();
    return;
  }

  const nextCount = Math.min(groups.length, renderedGroupCount + DICTIONARY_BATCH_SIZE);
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

  if (typeof window.IntersectionObserver !== "function") {
    appendGroupCards(groups.length);
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
  if (!group || group.entries.length <= 1) {
    return;
  }

  group.expanded = !group.expanded;

  const card = getCardByWord(word);
  if (!card) {
    renderDictionary(renderedGroupCount);
    return;
  }

  const history = card.querySelector(".dictionary-history");
  if (history) {
    history.hidden = !group.expanded;
  }

  const toggle = card.querySelector(".dictionary-history-toggle");
  if (toggle) {
    toggle.textContent = group.expanded ? "Hide history" : `Show history (${group.entries.length - 1})`;
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

async function createEditedEntry(sourceEntry, newMeaning) {
  const rowId = createRowId();
  const now = Date.now();

  const entry = {
    id: buildEntryId(rowId, now),
    rowId,
    timestamp: now,
    updatedTimestamp: now,
    unheartedTimestamp: null,
    user: sourceEntry.user || (await getIdentityId()),
    word: sourceEntry.word,
    pronunciation: sourceEntry.pronunciation,
    meaning: newMeaning,
    hearted: true,
    draftMeaning: newMeaning,
    hasDraftCache: true,
    isEditing: false,
    saveStatus: "idle",
    copyFlash: false
  };

  await putDictionaryRecord(entry);
  return entry;
}

function removeEntryFromDictionary(entryId) {
  clearCopyFeedback(entryId);

  if (selectedEntryId === entryId) {
    selectedEntryId = null;
  }

  if (playingEntryId === entryId) {
    stopAudio();
  }

  entriesById.delete(entryId);

  const previousCount = renderedGroupCount;
  rebuildGroupsFromEntries();

  if (groups.length === 0) {
    if (dictionaryList) {
      dictionaryList.textContent = "";
    }

    setStatus("No defined words yet.");
    updateSentinelVisibility();
    return;
  }

  setStatus("");
  renderDictionary(previousCount);
}

async function handleToggleHeart(entryId) {
  const entry = entriesById.get(entryId);
  if (!entry || !isDictionaryConfigured) {
    return;
  }

  const previousUser = entry.user;
  const previousUpdatedTimestamp = entry.updatedTimestamp;
  const previousUnheartedTimestamp = entry.unheartedTimestamp;
  entry.saveStatus = "saving-heart";
  renderEntryRow(entryId);

  try {
    const now = Date.now();
    entry.user = entry.user || (await getIdentityId());
    entry.hearted = false;
    entry.updatedTimestamp = now;
    entry.unheartedTimestamp = now;

    await putDictionaryRecord(entry);
    removeEntryFromDictionary(entryId);
  } catch (error) {
    entry.user = previousUser;
    entry.hearted = true;
    entry.updatedTimestamp = previousUpdatedTimestamp;
    entry.unheartedTimestamp = previousUnheartedTimestamp;
    entry.saveStatus = "idle";
    renderEntryRow(entryId);
    console.error("Failed to soft-delete dictionary entry.", error);
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

  const previousEditing = entry.isEditing;
  const previousStatus = entry.saveStatus;
  const previousDraft = entry.draftMeaning;

  entry.isEditing = false;
  entry.saveStatus = "saving-meaning";
  renderEntryRow(entryId);

  try {
    const newEntry = await createEditedEntry(entry, trimmedMeaning);

    entry.saveStatus = "idle";
    entry.isEditing = false;
    entry.draftMeaning = previousDraft;

    entriesById.set(newEntry.id, newEntry);
    const previousCount = renderedGroupCount;
    rebuildGroupsFromEntries();
    setStatus("");
    renderDictionary(previousCount);
    setSelectedEntry(newEntry.id);
  } catch (error) {
    entry.isEditing = previousEditing;
    entry.saveStatus = previousStatus;
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

async function loadDictionary() {
  if (!dictionaryList || !dictionaryStatus) {
    return;
  }

  if (!isDictionaryConfigured) {
    setStatus("Dictionary is unavailable. Configure AWS guest access to load definitions.", "error");
    updateSentinelVisibility();
    return;
  }

  setStatus("Loading dictionary...");

  const ready = await ensureAwsCredentials();
  if (!ready) {
    setStatus("Could not initialize AWS guest credentials.", "error");
    updateSentinelVisibility();
    return;
  }

  try {
    const rawItems = await scanDefinedHeartedEntries();

    entriesById.clear();
    for (const rawItem of rawItems) {
      const entry = normalizeDictionaryEntry(rawItem);
      if (!entry) {
        continue;
      }

      entriesById.set(entry.id, entry);
    }

    rebuildGroupsFromEntries();

    if (groups.length === 0) {
      if (dictionaryList) {
        dictionaryList.textContent = "";
      }

      setStatus("No defined words yet.");
      updateSentinelVisibility();
      return;
    }

    setStatus("");
    renderDictionary();
    setupObserver();
  } catch (error) {
    console.error("Failed to load dictionary entries.", error);
    setStatus("Failed to load dictionary entries.", "error");
    updateSentinelVisibility();
  }
}

sharedAudio.addEventListener("ended", () => clearPlayState());
sharedAudio.addEventListener("error", () => clearPlayState());

if (dictionaryList) {
  dictionaryList.addEventListener("click", (event) => {
    void handleDictionaryListClick(event);
  });

  dictionaryList.addEventListener("input", handleMeaningInput);
  dictionaryList.addEventListener("keydown", handleMeaningInputKeydown);
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".dictionary-entry") || event.target.closest(".dictionary-history-toggle")) {
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
