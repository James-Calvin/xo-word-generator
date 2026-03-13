(function bootstrapLoveLanguageShared(globalScope) {
  const awsHelperNamespace = globalScope.LOVE_LANGUAGE_AWS || {};
  const normalizeConfig =
    typeof awsHelperNamespace.normalizeConfig === "function"
      ? awsHelperNamespace.normalizeConfig
      : function normalizeWithoutHelpers(rawConfig) {
          return rawConfig && typeof rawConfig === "object" ? { ...rawConfig } : {};
        };

  function trimOrEmpty(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function hasMeaningText(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function toEpochMs(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function createRowId() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return globalScope.crypto.randomUUID();
    }

    return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function getAudioMimeType(outputFormat) {
    if (outputFormat === "ogg_vorbis") {
      return "audio/ogg";
    }

    if (outputFormat === "pcm") {
      return "audio/wav";
    }

    return "audio/mpeg";
  }

  function escapeXml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function decodeBase64(base64Text) {
    const binary = atob(base64Text);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  function toAudioBlob(audioStream, outputFormat) {
    const mimeType = getAudioMimeType(outputFormat);

    if (audioStream instanceof ArrayBuffer) {
      return new Blob([audioStream], { type: mimeType });
    }

    if (ArrayBuffer.isView(audioStream)) {
      return new Blob(
        [new Uint8Array(audioStream.buffer, audioStream.byteOffset, audioStream.byteLength)],
        { type: mimeType }
      );
    }

    if (typeof audioStream === "string") {
      return new Blob([decodeBase64(audioStream)], { type: mimeType });
    }

    return null;
  }

  function createActionButton(className, icon, label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-btn ${className}`;
    button.dataset.icon = icon;
    button.dataset.action = action;
    button.textContent = icon;
    button.setAttribute("aria-label", label);
    return button;
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }

    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.top = "-9999px";
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    document.body.removeChild(helper);
  }

  function buildCopyPayload({ word, pronunciation, ipa, meaning }) {
    const normalizedWord = trimOrEmpty(word);
    const normalizedPronunciation = trimOrEmpty(pronunciation) || trimOrEmpty(ipa);
    const normalizedMeaning = trimOrEmpty(meaning);

    if (!normalizedWord && !normalizedPronunciation) {
      return "";
    }

    const base =
      normalizedWord && normalizedPronunciation
        ? `${normalizedWord} /${normalizedPronunciation}/`
        : normalizedWord || `/${normalizedPronunciation}/`;

    return normalizedMeaning ? `${base} : ${normalizedMeaning}` : base;
  }

  function createAwsRuntime(options = {}) {
    const awsConfig = normalizeConfig(options.awsConfig ?? globalScope.LOVE_LANGUAGE_AWS_CONFIG);
    const hasAwsSdk =
      typeof globalScope.AWS !== "undefined" &&
      typeof globalScope.AWS.Polly !== "undefined" &&
      typeof globalScope.AWS.CognitoIdentityCredentials !== "undefined";

    const hasDocumentClient = Boolean(
      hasAwsSdk &&
        typeof globalScope.AWS.DynamoDB !== "undefined" &&
        typeof globalScope.AWS.DynamoDB.DocumentClient !== "undefined"
    );

    const isPlaybackConfigured = Boolean(hasAwsSdk && awsConfig.region && awsConfig.identityPoolId);
    const isHeartsConfigured = Boolean(
      isPlaybackConfigured && hasDocumentClient && awsConfig.heartsTableName
    );

    let awsInitPromise = null;
    let pollyClient = null;
    let heartsTableClient = null;

    function getPollyClient() {
      if (!isPlaybackConfigured) {
        return null;
      }

      if (!pollyClient) {
        pollyClient = new globalScope.AWS.Polly({ apiVersion: "2016-06-10", region: awsConfig.region });
      }

      return pollyClient;
    }

    function getHeartsTableClient() {
      if (!isHeartsConfigured) {
        return null;
      }

      if (!heartsTableClient) {
        heartsTableClient = new globalScope.AWS.DynamoDB.DocumentClient({ region: awsConfig.region });
      }

      return heartsTableClient;
    }

    function applyAwsCredentialsToClients(credentials) {
      const currentPollyClient = getPollyClient();
      if (currentPollyClient && credentials) {
        currentPollyClient.config.update({
          region: awsConfig.region,
          credentials
        });
      }

      const currentHeartsClient = getHeartsTableClient();
      if (currentHeartsClient && currentHeartsClient.service && credentials) {
        currentHeartsClient.service.config.update({
          region: awsConfig.region,
          credentials
        });
      }
    }

    function refreshAwsCredentials() {
      return new Promise((resolve, reject) => {
        if (!globalScope.AWS.config.credentials) {
          reject(new Error("Missing AWS credentials configuration."));
          return;
        }

        globalScope.AWS.config.credentials.get((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    async function ensureAwsCredentials() {
      if (!isPlaybackConfigured) {
        return false;
      }

      if (!awsInitPromise) {
        awsInitPromise = (async () => {
          globalScope.AWS.config.update({
            region: awsConfig.region,
            credentials: new globalScope.AWS.CognitoIdentityCredentials({
              IdentityPoolId: awsConfig.identityPoolId
            })
          });

          await refreshAwsCredentials();
          applyAwsCredentialsToClients(globalScope.AWS.config.credentials);

          return true;
        })().catch((error) => {
          console.error("Failed to initialize AWS credentials.", error);
          awsInitPromise = null;
          return false;
        });
      }

      const ready = await awsInitPromise;
      if (!ready) {
        return false;
      }

      try {
        const credentials = globalScope.AWS.config.credentials;
        if (!credentials) {
          throw new Error("Missing AWS credentials object.");
        }

        if (!credentials.identityId || credentials.expired) {
          await refreshAwsCredentials();
        }

        applyAwsCredentialsToClients(globalScope.AWS.config.credentials);
        return true;
      } catch (error) {
        console.error("Failed to refresh AWS credentials.", error);
        awsInitPromise = null;
        return false;
      }
    }

    async function getIdentityId() {
      const ready = await ensureAwsCredentials();
      if (!ready) {
        throw new Error("AWS guest credentials are unavailable.");
      }

      const credentials = globalScope.AWS.config.credentials;
      if (!credentials) {
        throw new Error("Missing AWS credentials object.");
      }

      if (!credentials.identityId || credentials.expired) {
        await refreshAwsCredentials();
      }

      if (!credentials.identityId) {
        throw new Error("Could not resolve Cognito identity ID.");
      }

      return credentials.identityId;
    }

    return {
      awsConfig,
      hasAwsSdk,
      hasDocumentClient,
      isPlaybackConfigured,
      isHeartsConfigured,
      getPollyClient,
      getHeartsTableClient,
      refreshAwsCredentials,
      ensureAwsCredentials,
      getIdentityId
    };
  }

  globalScope.LOVE_LANGUAGE_SHARED = {
    utils: {
      trimOrEmpty,
      hasMeaningText,
      toEpochMs,
      createRowId,
      getAudioMimeType,
      decodeBase64,
      toAudioBlob,
      escapeXml
    },
    ui: {
      createActionButton,
      copyTextToClipboard,
      buildCopyPayload
    },
    createAwsRuntime
  };
})(window);
