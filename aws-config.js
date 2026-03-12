// Set this object with your deployed Cognito Identity Pool settings to enable playback.
// Set heartsTableName to enable heart/meaning persistence.
// Leave region/identityPoolId blank to keep AWS-backed features hidden.
window.LOVE_LANGUAGE_AWS_CONFIG = {
  region: "us-east-1",
  identityPoolId: "us-east-1:79fd87b6-81b8-4982-b13a-9f16c670b0c2",
  heartsTableName: "xoHearts",
  heartsWordTimestampIndexName: "word-timestamp-index",
  voiceId: "Joanna",
  engine: "neural",
  outputFormat: "mp3"
};

window.LOVE_LANGUAGE_AWS = (() => {
  const defaults = {
    voiceId: "Joanna",
    engine: "neural",
    outputFormat: "mp3",
    heartsWordTimestampIndexName: "word-timestamp-index"
  };

  function trim(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function normalizeConfig(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

    return {
      region: trim(source.region),
      identityPoolId: trim(source.identityPoolId),
      heartsTableName: trim(source.heartsTableName),
      heartsWordTimestampIndexName:
        trim(source.heartsWordTimestampIndexName) || defaults.heartsWordTimestampIndexName,
      voiceId: trim(source.voiceId) || defaults.voiceId,
      engine: trim(source.engine) || defaults.engine,
      outputFormat: trim(source.outputFormat) || defaults.outputFormat
    };
  }

  return {
    defaults,
    normalizeConfig
  };
})();
