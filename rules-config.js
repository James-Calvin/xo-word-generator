(function bootstrapLoveLanguageRules(globalScope) {
  const sharedApi = globalScope.LOVE_LANGUAGE_SHARED || {};
  const sharedUtils = sharedApi.utils || {};

  const trimOrEmpty =
    typeof sharedUtils.trimOrEmpty === "function"
      ? sharedUtils.trimOrEmpty
      : (value) => (typeof value === "string" ? value.trim() : "");

  const SLOT_TYPES = {
    CONSONANT: "C",
    VOWEL: "V"
  };

  const SYLLABLE_PATTERN_KEYS = ["single", "initial", "medial", "final"];
  const TRANSITION_SCOPES = ["word", "syllable", "boundary"];
  const RULE_CONFIG_VERSION = 1;
  const ACTIVE_RULES_STORAGE_KEY = "xo.generator-rules.active.v1";
  const DRAFT_RULES_STORAGE_KEY = "xo.generator-rules.draft.v1";

  const DEFAULT_RULE_CONFIG = {
    version: RULE_CONFIG_VERSION,
    vowels: [
      { symbol: "a", ipa: "æ" },
      { symbol: "ie", ipa: "i" },
      { symbol: "ai", ipa: "eɪ" },
      { symbol: "i", ipa: "ɪ" },
      { symbol: "u", ipa: "ə" },
      { symbol: "au", ipa: "a" },
      { symbol: "o", ipa: "ō" },
      { symbol: "oo", ipa: "u" }
    ],
    consonants: [
      { symbol: "g", ipa: "g" },
      { symbol: "b", ipa: "b" },
      { symbol: "r", ipa: "r" },
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
      { symbol: "t", ipa: "t" }
    ],
    syllablePatterns: {
      single: ["CV", "V", "CVC"],
      initial: ["CV", "V"],
      medial: ["CV"],
      final: ["CV", "CVC"]
    },
    transitionRules: [],
    wordEndBans: [],
    syllableEndBans: ["y", "ñ", "j"]
  };

  function getLocalStorageHandle() {
    try {
      return globalScope.localStorage;
    } catch (error) {
      return null;
    }
  }

  function createBlankRuleConfig() {
    return {
      version: RULE_CONFIG_VERSION,
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
    };
  }

  function cloneRuleConfig(config) {
    return JSON.parse(JSON.stringify(normalizeRuleConfig(config)));
  }

  function normalizeSymbolEntry(entry) {
    return {
      symbol: trimOrEmpty(entry && entry.symbol),
      ipa: trimOrEmpty(entry && entry.ipa)
    };
  }

  function normalizePatternValue(pattern) {
    return trimOrEmpty(pattern).toUpperCase().replace(/\s+/g, "");
  }

  function normalizeStringArray(values, options = {}) {
    const {
      transform = (value) => trimOrEmpty(value),
      dedupe = false
    } = options;

    if (!Array.isArray(values)) {
      return [];
    }

    const result = [];
    const seen = new Set();

    for (const value of values) {
      const normalizedValue = transform(value);
      if (dedupe) {
        if (seen.has(normalizedValue)) {
          continue;
        }

        seen.add(normalizedValue);
      }

      result.push(normalizedValue);
    }

    return result;
  }

  function normalizeTransitionRule(rule) {
    const rawBlockedSymbols = Array.isArray(rule && rule.blockedNextSymbols)
      ? rule.blockedNextSymbols
      : typeof (rule && rule.blockedNextSymbols) === "string"
        ? rule.blockedNextSymbols.split(",")
        : [];

    return {
      scope: trimOrEmpty(rule && rule.scope).toLowerCase(),
      triggerSymbol: trimOrEmpty(rule && rule.triggerSymbol),
      blockedNextSymbols: normalizeStringArray(rawBlockedSymbols, { dedupe: true })
    };
  }

  function normalizeRuleConfig(rawConfig) {
    const source =
      rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
    const rawPatterns =
      source.syllablePatterns &&
      typeof source.syllablePatterns === "object" &&
      !Array.isArray(source.syllablePatterns)
        ? source.syllablePatterns
        : {};

    const normalizedConfig = createBlankRuleConfig();
    normalizedConfig.vowels = Array.isArray(source.vowels) ? source.vowels.map(normalizeSymbolEntry) : [];
    normalizedConfig.consonants = Array.isArray(source.consonants)
      ? source.consonants.map(normalizeSymbolEntry)
      : [];
    normalizedConfig.transitionRules = Array.isArray(source.transitionRules)
      ? source.transitionRules.map(normalizeTransitionRule)
      : [];
    normalizedConfig.wordEndBans = normalizeStringArray(source.wordEndBans, { dedupe: true });
    normalizedConfig.syllableEndBans = normalizeStringArray(source.syllableEndBans, {
      dedupe: true
    });

    for (const key of SYLLABLE_PATTERN_KEYS) {
      normalizedConfig.syllablePatterns[key] = normalizeStringArray(rawPatterns[key], {
        transform: normalizePatternValue
      });
    }

    return normalizedConfig;
  }

  function getKnownSymbols(config) {
    const symbols = new Set();

    for (const entry of [...config.vowels, ...config.consonants]) {
      if (entry.symbol) {
        symbols.add(entry.symbol);
      }
    }

    return symbols;
  }

  function validateRuleConfig(rawConfig) {
    const config = normalizeRuleConfig(rawConfig);
    const errors = [];
    const knownSymbols = new Set();
    const symbolLabels = new Map();
    let hasAnyPattern = false;
    let patternUsesConsonant = false;

    function recordSymbol(entry, label) {
      if (!entry.symbol) {
        return;
      }

      if (symbolLabels.has(entry.symbol)) {
        errors.push(`Symbol "${entry.symbol}" is duplicated in ${symbolLabels.get(entry.symbol)} and ${label}.`);
      } else {
        symbolLabels.set(entry.symbol, label);
      }

      knownSymbols.add(entry.symbol);
    }

    config.vowels.forEach((entry, index) => {
      const label = `vowel ${index + 1}`;
      if (!entry.symbol) {
        errors.push(`Vowel ${index + 1} is missing a symbol.`);
      }
      if (!entry.ipa) {
        errors.push(`Vowel ${index + 1} is missing an IPA sound.`);
      }
      recordSymbol(entry, label);
    });

    config.consonants.forEach((entry, index) => {
      const label = `consonant ${index + 1}`;
      if (!entry.symbol) {
        errors.push(`Consonant ${index + 1} is missing a symbol.`);
      }
      if (!entry.ipa) {
        errors.push(`Consonant ${index + 1} is missing an IPA sound.`);
      }
      recordSymbol(entry, label);
    });

    if (config.vowels.length === 0) {
      errors.push("Add at least one vowel symbol.");
    }

    for (const key of SYLLABLE_PATTERN_KEYS) {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      const patterns = config.syllablePatterns[key];

      patterns.forEach((pattern, index) => {
        if (!pattern) {
          errors.push(`${label} pattern ${index + 1} is blank.`);
          return;
        }

        hasAnyPattern = true;

        if (/[^CV]/.test(pattern)) {
          errors.push(`${label} pattern ${index + 1} must use only C and V.`);
        }

        if (pattern.includes(SLOT_TYPES.CONSONANT)) {
          patternUsesConsonant = true;
        }
      });
    }

    if (!hasAnyPattern) {
      errors.push("Add at least one syllable pattern.");
    }

    if (patternUsesConsonant && config.consonants.length === 0) {
      errors.push("Add at least one consonant symbol or remove C from every syllable pattern.");
    }

    config.transitionRules.forEach((rule, index) => {
      const label = `Transition rule ${index + 1}`;
      if (!TRANSITION_SCOPES.includes(rule.scope)) {
        errors.push(`${label} has an invalid scope.`);
      }

      if (!rule.triggerSymbol) {
        errors.push(`${label} is missing a trigger symbol.`);
      } else if (!knownSymbols.has(rule.triggerSymbol)) {
        errors.push(`${label} references an unknown trigger symbol "${rule.triggerSymbol}".`);
      }

      if (!Array.isArray(rule.blockedNextSymbols) || rule.blockedNextSymbols.length === 0) {
        errors.push(`${label} must block at least one next symbol.`);
        return;
      }

      rule.blockedNextSymbols.forEach((symbol) => {
        if (!symbol) {
          errors.push(`${label} has a blank blocked symbol.`);
        } else if (!knownSymbols.has(symbol)) {
          errors.push(`${label} references an unknown blocked symbol "${symbol}".`);
        }
      });
    });

    config.wordEndBans.forEach((symbol, index) => {
      if (!symbol) {
        errors.push(`Word-end ban ${index + 1} is blank.`);
      } else if (!knownSymbols.has(symbol)) {
        errors.push(`Word-end ban ${index + 1} references an unknown symbol "${symbol}".`);
      }
    });

    config.syllableEndBans.forEach((symbol, index) => {
      if (!symbol) {
        errors.push(`Syllable-end ban ${index + 1} is blank.`);
      } else if (!knownSymbols.has(symbol)) {
        errors.push(`Syllable-end ban ${index + 1} references an unknown symbol "${symbol}".`);
      }
    });

    return {
      isValid: errors.length === 0,
      errors: [...new Set(errors)],
      config,
      knownSymbols: [...getKnownSymbols(config)]
    };
  }

  function getPatternsForCount(config, syllableCount, position) {
    if (syllableCount === 1) {
      return config.syllablePatterns.single;
    }

    if (position === 0) {
      return config.syllablePatterns.initial;
    }

    if (position === syllableCount - 1) {
      return config.syllablePatterns.final;
    }

    return config.syllablePatterns.medial;
  }

  function isPatternCompatible(pattern, symbolsByType, syllableEndBans, wordEndBans, isWordFinal) {
    if (!pattern || /[^CV]/.test(pattern)) {
      return false;
    }

    for (const token of pattern) {
      if (!Array.isArray(symbolsByType[token]) || symbolsByType[token].length === 0) {
        return false;
      }
    }

    const lastToken = pattern.charAt(pattern.length - 1);
    const endCandidates = symbolsByType[lastToken].filter((symbol) => {
      if (syllableEndBans.has(symbol)) {
        return false;
      }

      if (isWordFinal && wordEndBans.has(symbol)) {
        return false;
      }

      return true;
    });

    return endCandidates.length > 0;
  }

  function evaluateRuleConfigCompatibility(rawConfig, minSyllables, maxSyllables) {
    const validation = validateRuleConfig(rawConfig);
    if (!validation.isValid) {
      return {
        isReady: false,
        message: validation.errors[0] || "Rules are invalid.",
        errors: validation.errors,
        config: validation.config
      };
    }

    const config = validation.config;
    const min = Math.max(1, Number.isInteger(Number(minSyllables)) ? Number(minSyllables) : 1);
    const max = Math.max(min, Number.isInteger(Number(maxSyllables)) ? Number(maxSyllables) : min);
    const symbolsByType = {
      [SLOT_TYPES.CONSONANT]: config.consonants.map((entry) => entry.symbol).filter(Boolean),
      [SLOT_TYPES.VOWEL]: config.vowels.map((entry) => entry.symbol).filter(Boolean)
    };
    const syllableEndBans = new Set(config.syllableEndBans.filter(Boolean));
    const wordEndBans = new Set(config.wordEndBans.filter(Boolean));

    for (let syllableCount = min; syllableCount <= max; syllableCount += 1) {
      for (let position = 0; position < syllableCount; position += 1) {
        const isWordFinal = position === syllableCount - 1;
        const options = getPatternsForCount(config, syllableCount, position);
        const hasCompatiblePattern = options.some((pattern) =>
          isPatternCompatible(pattern, symbolsByType, syllableEndBans, wordEndBans, isWordFinal)
        );

        if (hasCompatiblePattern) {
          continue;
        }

        if (syllableCount === 1) {
          return {
            isReady: false,
            message:
              "Current rules cannot generate single-syllable words for the selected syllable range.",
            errors: [],
            config
          };
        }

        if (position === 0) {
          return {
            isReady: false,
            message: `Current rules cannot generate ${syllableCount}-syllable words because no compatible initial pattern is available.`,
            errors: [],
            config
          };
        }

        if (isWordFinal) {
          return {
            isReady: false,
            message: `Current rules cannot generate ${syllableCount}-syllable words because no compatible final pattern is available.`,
            errors: [],
            config
          };
        }

        return {
          isReady: false,
          message: `Current rules cannot generate ${syllableCount}-syllable words because no compatible medial pattern is available.`,
          errors: [],
          config
        };
      }
    }

    return {
      isReady: true,
      message: "",
      errors: [],
      config
    };
  }

  function getRelationToNextForEntries(entries, index, syllableSpans) {
    if (index >= entries.length - 1) {
      return "none";
    }

    for (const span of syllableSpans) {
      if (index >= span.startIndex && index < span.endIndex - 1) {
        return "sameSyllable";
      }

      if (index === span.endIndex - 1) {
        return "boundary";
      }
    }

    return "none";
  }

  function resolveBlockedNextSymbolsForConfig(config, triggerSymbol, relationToNext) {
    if (relationToNext === "none") {
      return [];
    }

    const blocked = [];
    for (const rule of config.transitionRules) {
      if (rule.triggerSymbol !== triggerSymbol) {
        continue;
      }

      if (rule.scope === "word") {
        if (relationToNext === "sameSyllable" || relationToNext === "boundary") {
          blocked.push(...rule.blockedNextSymbols);
        }
        continue;
      }

      if (rule.scope === "syllable" && relationToNext === "sameSyllable") {
        blocked.push(...rule.blockedNextSymbols);
        continue;
      }

      if (rule.scope === "boundary" && relationToNext === "boundary") {
        blocked.push(...rule.blockedNextSymbols);
      }
    }

    return [...new Set(blocked)];
  }

  function normalizePronunciationForComparison(value) {
    return trimOrEmpty(value)
      .replace(/[./\s]+/g, "")
      .replace(/^\/+|\/+$/g, "");
  }

  function buildAnalyzerSymbolEntries(config) {
    const entries = [];

    for (const vowel of config.vowels) {
      if (!vowel.symbol || !vowel.ipa) {
        continue;
      }

      entries.push({
        symbol: vowel.symbol,
        ipa: vowel.ipa,
        type: SLOT_TYPES.VOWEL
      });
    }

    for (const consonant of config.consonants) {
      if (!consonant.symbol || !consonant.ipa) {
        continue;
      }

      entries.push({
        symbol: consonant.symbol,
        ipa: consonant.ipa,
        type: SLOT_TYPES.CONSONANT
      });
    }

    return entries.sort((left, right) => {
      const lengthDiff = right.symbol.length - left.symbol.length;
      if (lengthDiff !== 0) {
        return lengthDiff;
      }

      return left.symbol.localeCompare(right.symbol);
    });
  }

  function buildExpectedPronunciation(symbolEntries, syllableSpans) {
    return syllableSpans
      .map((span) =>
        symbolEntries
          .slice(span.startIndex, span.endIndex)
          .map((entry) => entry.ipa)
          .join("")
      )
      .join(".");
  }

  function buildSegmentation(symbolEntries, syllableSpans) {
    return syllableSpans.map((span) =>
      symbolEntries.slice(span.startIndex, span.endIndex).map((entry) => entry.symbol)
    );
  }

  function doPatternTypesMatch(symbolEntries, startIndex, pattern) {
    if (!pattern || startIndex + pattern.length > symbolEntries.length) {
      return false;
    }

    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (symbolEntries[startIndex + offset].type !== pattern.charAt(offset)) {
        return false;
      }
    }

    return true;
  }

  function validateTransitionSequence(config, symbolEntries, syllableSpans) {
    const syllableEndBans = new Set(config.syllableEndBans.filter(Boolean));
    const wordEndBans = new Set(config.wordEndBans.filter(Boolean));

    for (const span of syllableSpans) {
      const lastEntry = symbolEntries[span.endIndex - 1];
      if (!lastEntry) {
        return false;
      }

      if (syllableEndBans.has(lastEntry.symbol)) {
        return false;
      }
    }

    const finalEntry = symbolEntries[symbolEntries.length - 1];
    if (finalEntry && wordEndBans.has(finalEntry.symbol)) {
      return false;
    }

    for (let index = 0; index < symbolEntries.length - 1; index += 1) {
      const currentEntry = symbolEntries[index];
      const nextEntry = symbolEntries[index + 1];
      const relationToNext = getRelationToNextForEntries(symbolEntries, index, syllableSpans);
      const blockedSymbols = resolveBlockedNextSymbolsForConfig(
        config,
        currentEntry.symbol,
        relationToNext
      );

      if (blockedSymbols.includes(nextEntry.symbol)) {
        return false;
      }
    }

    return true;
  }

  function findValidSyllableSpans(config, symbolEntries) {
    if (!Array.isArray(symbolEntries) || symbolEntries.length === 0) {
      return null;
    }

    for (let syllableCount = 1; syllableCount <= symbolEntries.length; syllableCount += 1) {
      const spans = [];

      function backtrack(symbolIndex, syllableIndex) {
        if (syllableIndex === syllableCount) {
          return symbolIndex === symbolEntries.length;
        }

        const patternOptions = getPatternsForCount(config, syllableCount, syllableIndex);
        if (!Array.isArray(patternOptions) || patternOptions.length === 0) {
          return false;
        }

        for (const pattern of patternOptions) {
          if (!pattern || !doPatternTypesMatch(symbolEntries, symbolIndex, pattern)) {
            continue;
          }

          const endIndex = symbolIndex + pattern.length;
          if (endIndex > symbolEntries.length) {
            continue;
          }

          spans.push({
            pattern,
            startIndex: symbolIndex,
            endIndex
          });

          if (backtrack(endIndex, syllableIndex + 1)) {
            return true;
          }

          spans.pop();
        }

        return false;
      }

      if (backtrack(0, 0) && validateTransitionSequence(config, symbolEntries, spans)) {
        return spans.map((span) => ({ ...span }));
      }
    }

    return null;
  }

  function analyzeEntryAgainstRuleConfig({ word, pronunciation, config } = {}) {
    const normalizedWord = trimOrEmpty(word);
    const normalizedPronunciation = trimOrEmpty(pronunciation);
    const validation = validateRuleConfig(config);

    if (!validation.isValid) {
      return {
        available: false,
        matchesRules: true,
        warnings: [],
        segmentation: [],
        expectedPronunciation: "",
        config: validation.config
      };
    }

    const normalizedConfig = validation.config;
    if (!normalizedWord) {
      return {
        available: true,
        matchesRules: true,
        warnings: [],
        segmentation: [],
        expectedPronunciation: "",
        config: normalizedConfig
      };
    }

    const symbolEntries = buildAnalyzerSymbolEntries(normalizedConfig);
    const activeSymbols = symbolEntries.filter((entry) => normalizedWord.startsWith(entry.symbol));
    if (activeSymbols.length === 0 && symbolEntries.length === 0) {
      return {
        available: true,
        matchesRules: false,
        warnings: ["Word does not match the current generator symbols or syllable rules."],
        segmentation: [],
        expectedPronunciation: "",
        config: normalizedConfig
      };
    }

    let matchedEntries = null;
    let matchedSyllableSpans = null;

    function backtrackTokenize(index, collectedEntries) {
      if (index === normalizedWord.length) {
        const syllableSpans = findValidSyllableSpans(normalizedConfig, collectedEntries);
        if (syllableSpans) {
          matchedEntries = [...collectedEntries];
          matchedSyllableSpans = syllableSpans;
          return true;
        }

        return false;
      }

      const matchingEntries = symbolEntries.filter((entry) =>
        normalizedWord.startsWith(entry.symbol, index)
      );

      for (const entry of matchingEntries) {
        collectedEntries.push(entry);
        if (backtrackTokenize(index + entry.symbol.length, collectedEntries)) {
          return true;
        }
        collectedEntries.pop();
      }

      return false;
    }

    backtrackTokenize(0, []);

    if (!matchedEntries || !matchedSyllableSpans) {
      return {
        available: true,
        matchesRules: false,
        warnings: ["Word does not match the current generator symbols or syllable rules."],
        segmentation: [],
        expectedPronunciation: "",
        config: normalizedConfig
      };
    }

    const expectedPronunciation = buildExpectedPronunciation(matchedEntries, matchedSyllableSpans);
    const warnings = [];
    const normalizedExpected = normalizePronunciationForComparison(expectedPronunciation);
    const normalizedActual = normalizePronunciationForComparison(normalizedPronunciation);

    if (normalizedPronunciation && normalizedExpected !== normalizedActual) {
      warnings.push(`IPA does not match the current symbol sounds (expected /${expectedPronunciation}/).`);
    }

    return {
      available: true,
      matchesRules: warnings.length === 0,
      warnings,
      segmentation: buildSegmentation(matchedEntries, matchedSyllableSpans),
      expectedPronunciation,
      config: normalizedConfig
    };
  }

  function loadStoredRuleConfig(storageKey) {
    const storage = getLocalStorageHandle();
    if (!storage) {
      return null;
    }

    try {
      const rawValue = storage.getItem(storageKey);
      if (!rawValue) {
        return null;
      }

      return normalizeRuleConfig(JSON.parse(rawValue));
    } catch (error) {
      console.error("Failed to load stored rule config.", error);
      return null;
    }
  }

  function saveStoredRuleConfig(storageKey, config) {
    const storage = getLocalStorageHandle();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(storageKey, JSON.stringify(normalizeRuleConfig(config)));
    } catch (error) {
      console.error("Failed to save stored rule config.", error);
    }
  }

  function getDefaultRuleConfig() {
    return cloneRuleConfig(DEFAULT_RULE_CONFIG);
  }

  function loadActiveRuleConfig() {
    const storedConfig = loadStoredRuleConfig(ACTIVE_RULES_STORAGE_KEY);
    if (!storedConfig) {
      return getDefaultRuleConfig();
    }

    const validation = validateRuleConfig(storedConfig);
    return validation.isValid ? cloneRuleConfig(validation.config) : getDefaultRuleConfig();
  }

  function loadDraftRuleConfig() {
    const storedDraft = loadStoredRuleConfig(DRAFT_RULES_STORAGE_KEY);
    if (storedDraft) {
      return cloneRuleConfig(storedDraft);
    }

    const storedActive = loadStoredRuleConfig(ACTIVE_RULES_STORAGE_KEY);
    if (storedActive) {
      return cloneRuleConfig(storedActive);
    }

    return getDefaultRuleConfig();
  }

  function saveDraftRuleConfig(config) {
    const normalizedConfig = normalizeRuleConfig(config);
    saveStoredRuleConfig(DRAFT_RULES_STORAGE_KEY, normalizedConfig);
    return cloneRuleConfig(normalizedConfig);
  }

  function saveActiveRuleConfig(config) {
    const normalizedConfig = normalizeRuleConfig(config);
    saveStoredRuleConfig(ACTIVE_RULES_STORAGE_KEY, normalizedConfig);
    return cloneRuleConfig(normalizedConfig);
  }

  function applyDraftRuleConfig(config) {
    const draft = saveDraftRuleConfig(config);
    const validation = validateRuleConfig(draft);
    let active = loadActiveRuleConfig();

    if (validation.isValid) {
      active = saveActiveRuleConfig(validation.config);
    }

    return {
      draft,
      active,
      validation,
      applied: validation.isValid
    };
  }

  function restoreDefaultRuleConfig() {
    const defaults = getDefaultRuleConfig();
    saveDraftRuleConfig(defaults);
    saveActiveRuleConfig(defaults);
    return defaults;
  }

  globalScope.LOVE_LANGUAGE_RULES = {
    SLOT_TYPES,
    TRANSITION_SCOPES,
    SYLLABLE_PATTERN_KEYS,
    RULE_CONFIG_VERSION,
    storageKeys: {
      active: ACTIVE_RULES_STORAGE_KEY,
      draft: DRAFT_RULES_STORAGE_KEY
    },
    createBlankRuleConfig,
    getDefaultRuleConfig,
    cloneRuleConfig,
    normalizeRuleConfig,
    validateRuleConfig,
    evaluateRuleConfigCompatibility,
    analyzeEntryAgainstRuleConfig,
    loadActiveRuleConfig,
    loadDraftRuleConfig,
    saveDraftRuleConfig,
    saveActiveRuleConfig,
    applyDraftRuleConfig,
    restoreDefaultRuleConfig
  };
})(window);
