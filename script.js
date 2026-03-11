const vowels = [
  { symbol: "a", ipa: "æ" },
  { symbol: "ee", ipa: "i" },
  { symbol: "ai", ipa: "eɪ" },
  { symbol: "i", ipa: "ɪ" },
  { symbol: "u", ipa: "ə" },
  { symbol: "au", ipa: "a" },
  { symbol: "o", ipa: "o" },
  { symbol: "oo", ipa: "u" }
];

const consonants = [
  { symbol: "g", ipa: "g" },
  { symbol: "b", ipa: "b" },
  { symbol: "r", ipa: "ɾ" },
  { symbol: "l", ipa: "l" },
  { symbol: "j", ipa: "d͡ʒ" },
  { symbol: "m", ipa: "m" },
  { symbol: "z", ipa: "z" },
  { symbol: "d", ipa: "d" },
  { symbol: "s", ipa: "s" },
  { symbol: "n", ipa: "n" },
  { symbol: "ch", ipa: "t͡ʃ" },
  { symbol: "x", ipa: "ʃ" },
  { symbol: "ñ", ipa: "ɲ" },
  { symbol: "y", ipa: "j" },
  { symbol: "t", ipa: "t͡s" },
];

const MAX_RESULTS = 50;
const RETRY_LIMIT = 100;

const minInput = document.getElementById("minSyllables");
const maxInput = document.getElementById("maxSyllables");
const generateBtn = document.getElementById("generateBtn");
const resultsList = document.getElementById("results");
const generatedWords = new Set();

const SLOT_TYPES = {
  CONSONANT: "C",
  VOWEL: "V"
};

const RELATIONS = {
  SAME_SYLLABLE: "sameSyllable",
  BOUNDARY: "boundary",
  NONE: "none"
};

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

class RuleEngine {
  constructor() {
    this.transitionRules = [];
    this.wordEndBans = new Set();
  }

  addWordRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("word", triggerSymbol, blockedNextSymbols);
  }

  addSyllableRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("syllable", triggerSymbol, blockedNextSymbols);
  }

  addBoundaryRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("boundary", triggerSymbol, blockedNextSymbols);
  }

  addWordEndBan(symbol) {
    this.wordEndBans.add(symbol);
  }

  addTransitionRule(scope, triggerSymbol, blockedNextSymbols) {
    const blocked = Array.isArray(blockedNextSymbols) ? blockedNextSymbols : [blockedNextSymbols];
    this.transitionRules.push({
      scope,
      triggerSymbol,
      blockedNextSymbols: [...new Set(blocked)]
    });
  }

  resolveBlockedNextSymbols(triggerSymbol, relationToNext) {
    const blocked = [];
    for (const rule of this.transitionRules) {
      if (rule.triggerSymbol !== triggerSymbol) {
        continue;
      }

      if (!this.matchesScope(rule.scope, relationToNext)) {
        continue;
      }

      blocked.push(...rule.blockedNextSymbols);
    }

    return [...new Set(blocked)];
  }

  matchesScope(scope, relationToNext) {
    if (relationToNext === RELATIONS.NONE) {
      return false;
    }

    if (scope === "word") {
      return relationToNext === RELATIONS.SAME_SYLLABLE || relationToNext === RELATIONS.BOUNDARY;
    }

    if (scope === "syllable") {
      return relationToNext === RELATIONS.SAME_SYLLABLE;
    }

    if (scope === "boundary") {
      return relationToNext === RELATIONS.BOUNDARY;
    }

    return false;
  }

  isWordEndBanned(symbol) {
    return this.wordEndBans.has(symbol);
  }
}

class PoolManager {
  constructor(vowelSymbols, consonantSymbols) {
    this.basePools = {
      [SLOT_TYPES.VOWEL]: vowelSymbols.map((symbol) => symbol.symbol),
      [SLOT_TYPES.CONSONANT]: consonantSymbols.map((symbol) => symbol.symbol)
    };

    this.symbolByType = {
      [SLOT_TYPES.VOWEL]: new Map(vowelSymbols.map((entry) => [entry.symbol, entry])),
      [SLOT_TYPES.CONSONANT]: new Map(consonantSymbols.map((entry) => [entry.symbol, entry]))
    };

    this.workingPools = {
      [SLOT_TYPES.VOWEL]: new Set(this.basePools[SLOT_TYPES.VOWEL]),
      [SLOT_TYPES.CONSONANT]: new Set(this.basePools[SLOT_TYPES.CONSONANT])
    };

    this.activeEvents = [];
    this.eventLog = [];
  }

  resetWordAttempt() {
    this.workingPools[SLOT_TYPES.VOWEL] = new Set(this.basePools[SLOT_TYPES.VOWEL]);
    this.workingPools[SLOT_TYPES.CONSONANT] = new Set(this.basePools[SLOT_TYPES.CONSONANT]);
    this.activeEvents = [];
    this.eventLog = [];
  }

  getCandidates(slotType) {
    const entries = this.symbolByType[slotType];
    const symbols = this.workingPools[slotType];
    return [...symbols].map((symbol) => entries.get(symbol));
  }

  applyNextPickRestrictions(slotType, blockedSymbols) {
    if (!blockedSymbols || blockedSymbols.length === 0) {
      return;
    }

    const removedSymbols = [];
    for (const symbol of blockedSymbols) {
      if (this.workingPools[slotType].has(symbol)) {
        this.workingPools[slotType].delete(symbol);
        removedSymbols.push(symbol);
      }
    }

    if (removedSymbols.length === 0) {
      return;
    }

    const event = { slotType, removedSymbols };
    this.activeEvents.push(event);
    this.eventLog.push(event);
  }

  restorePendingRestrictions() {
    for (const event of this.activeEvents) {
      for (const symbol of event.removedSymbols) {
        this.workingPools[event.slotType].add(symbol);
      }
    }

    this.activeEvents = [];
  }
}

function buildSyllablePattern(position, total) {
  if (total === 1) {
    return randomFrom(["CV", "V", "CVC"]);
  }

  if (position === 0) {
    return randomFrom(["CV", "V"]);
  }

  if (position === total - 1) {
    return randomFrom(["CV", "CVC"]);
  }

  return "CV";
}

function buildWordSlots(syllablePatterns) {
  const slots = [];

  for (let syllableIndex = 0; syllableIndex < syllablePatterns.length; syllableIndex += 1) {
    const pattern = syllablePatterns[syllableIndex];
    for (const token of pattern) {
      slots.push({
        type: token,
        syllableIndex,
        relationToNext: RELATIONS.NONE
      });
    }
  }

  for (let i = 0; i < slots.length - 1; i += 1) {
    if (slots[i].syllableIndex === slots[i + 1].syllableIndex) {
      slots[i].relationToNext = RELATIONS.SAME_SYLLABLE;
    } else {
      slots[i].relationToNext = RELATIONS.BOUNDARY;
    }
  }

  return slots;
}

function clampSyllables() {
  let min = Number(minInput.value);
  let max = Number(maxInput.value);

  if (!Number.isInteger(min)) {
    min = 1;
  }
  if (!Number.isInteger(max)) {
    max = min;
  }

  min = Math.max(1, Math.min(12, min));
  max = Math.max(1, Math.min(12, max));

  if (min > max) {
    [min, max] = [max, min];
  }

  minInput.value = String(min);
  maxInput.value = String(max);
  return { min, max };
}

const ruleEngine = new RuleEngine();
const poolManager = new PoolManager(vowels, consonants);

function addWordRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addWordRule(triggerSymbol, blockedNextSymbols);
}

function addSyllableRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addSyllableRule(triggerSymbol, blockedNextSymbols);
}

function addBoundaryRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addBoundaryRule(triggerSymbol, blockedNextSymbols);
}

function addWordEndBan(symbol) {
  ruleEngine.addWordEndBan(symbol);
}

addWordEndBan("y");
addWordEndBan("ñ");
addSyllableRule("o", ["r"]);

function buildWord(min, max) {
  const syllableCount = Math.floor(Math.random() * (max - min + 1)) + min;
  const syllablePatterns = [];
  for (let i = 0; i < syllableCount; i += 1) {
    syllablePatterns.push(buildSyllablePattern(i, syllableCount));
  }

  const slots = buildWordSlots(syllablePatterns);
  const symbolsBySyllable = Array.from({ length: syllableCount }, () => []);
  const ipaBySyllable = Array.from({ length: syllableCount }, () => []);
  const symbols = [];

  poolManager.resetWordAttempt();

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const candidates = poolManager.getCandidates(slot.type);
    if (candidates.length === 0) {
      poolManager.resetWordAttempt();
      return null;
    }

    const selected = randomFrom(candidates);
    symbols.push(selected.symbol);
    symbolsBySyllable[slot.syllableIndex].push(selected.symbol);
    ipaBySyllable[slot.syllableIndex].push(selected.ipa);

    // Restrictions are immediate-only and apply to this just-finished pick.
    poolManager.restorePendingRestrictions();

    const nextSlot = slots[i + 1];
    if (nextSlot) {
      const blockedSymbols = ruleEngine.resolveBlockedNextSymbols(selected.symbol, slot.relationToNext);
      poolManager.applyNextPickRestrictions(nextSlot.type, blockedSymbols);
    }
  }

  // Prevent temporary pool mutation from leaking across attempts.
  poolManager.resetWordAttempt();

  const lastSymbol = symbols[symbols.length - 1];
  if (ruleEngine.isWordEndBanned(lastSymbol)) {
    return null;
  }

  return {
    word: symbolsBySyllable.map((syllable) => syllable.join("")).join(""),
    ipa: ipaBySyllable.map((syllable) => syllable.join("")).join("."),
    symbols,
    syllables: symbolsBySyllable.map((syllable) => [...syllable])
  };
}

function generateUniqueWord(min, max) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    const candidate = buildWord(min, max);
    if (candidate && !generatedWords.has(candidate.word)) {
      return candidate;
    }
  }

  return null;
}

function addResult() {
  const { min, max } = clampSyllables();
  const generated = generateUniqueWord(min, max);

  if (!generated) {
    return;
  }

  const item = document.createElement("li");
  const wordSpan = document.createElement("span");
  const ipaSpan = document.createElement("span");

  item.dataset.word = generated.word;

  wordSpan.className = "word";
  wordSpan.textContent = generated.word;

  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${generated.ipa}/`;

  item.appendChild(wordSpan);
  item.appendChild(ipaSpan);
  resultsList.prepend(item);
  generatedWords.add(generated.word);

  while (resultsList.children.length > MAX_RESULTS) {
    const oldest = resultsList.lastElementChild;
    if (!oldest) {
      break;
    }

    const oldestWord = oldest.dataset.word;
    if (oldestWord) {
      generatedWords.delete(oldestWord);
    }

    oldest.remove();
  }
}

minInput.addEventListener("change", clampSyllables);
maxInput.addEventListener("change", clampSyllables);
generateBtn.addEventListener("click", addResult);
