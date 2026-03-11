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
  outputFormat: "mp3",
};
