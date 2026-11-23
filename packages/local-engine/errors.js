'use strict';
const messages = Object.freeze({
  INVALID_REQUEST: 'Request is not allowed by the local broker.',
  INVALID_MANIFEST: 'The engine bundle failed integrity validation. Reinstall the application.',
  PRIVATE_PATH: 'A private local directory or file is unsafe. Select a private application directory.',
  WINDOWS_PRIVATE_STORAGE_UNSUPPORTED: 'Windows private storage requires a verified native security helper.',
  START_FAILED: 'The owned local engine could not start.',
  START_TIMEOUT: 'The owned local engine did not become ready within 30 seconds.',
  INVALID_READY: 'The owned local engine returned an invalid readiness message.',
  AUTH_FAILED: 'The owned local engine failed local authentication.',
  ENGINE_EXITED: 'The owned local engine has stopped.',
  REQUEST_FAILED: 'The local request failed. No request was retried.',
  REQUEST_TIMEOUT: 'The local request timed out. No request was retried.',
  REQUEST_ABORTED: 'The local request was cancelled. No request was retried.',
  RESPONSE_TOO_LARGE: 'The local response exceeded 16 MiB. Narrow the query; no data was truncated.',
  REDIRECT_DENIED: 'The local engine returned a redirect. It was not followed.',
  KEY_UNAVAILABLE: 'The credential key could not be opened. Restore its original key and storage backend.',
  KEY_MISSING: 'Existing local data has no credential key. Restore its original key; it was not replaced.',
  KEY_INITIALIZING: 'Credential key initialization is incomplete or already in progress. No key was replaced.',
  FALLBACK_CONSENT_REQUIRED: 'Linux has no secure key backend. Explicit plaintext fallback consent is required.',
  KEY_BACKEND_UNAVAILABLE: 'The original secure key backend is unavailable. Unlock it and try again.',
  APP_NOT_READY: 'The Electron application must be ready before opening credential storage.'
});
function failure(code, uncertain = false) {
  const error = new Error(messages[code] || messages.REQUEST_FAILED);
  error.name = 'LocalEngineError'; error.code = code;
  if (uncertain) error.uncertainOutcome = true;
  return error;
}
module.exports = { failure };
