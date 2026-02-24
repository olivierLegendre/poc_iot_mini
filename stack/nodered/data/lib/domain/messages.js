'use strict';

const DEVICE_REFERENCE_SUGGESTION_MESSAGES = Object.freeze({
  blocked: 'missing required reference fields',
  already_linked: 'device is already linked to the suggested reference',
  suggest_relink: 'device is linked to a different reference than the suggested key',
  suggest_link_existing: 'an existing reference matches the suggested key',
  linked_reference_no_key_match: 'device is linked to a reference but no reference matches the suggested key',
  suggest_create_reference: 'no existing reference matches the suggested key'
});

function getDeviceReferenceSuggestionMessage(status, fallback) {
  if (typeof status === 'string' && status in DEVICE_REFERENCE_SUGGESTION_MESSAGES) {
    return DEVICE_REFERENCE_SUGGESTION_MESSAGES[status];
  }
  return fallback || DEVICE_REFERENCE_SUGGESTION_MESSAGES.blocked;
}

module.exports = {
  DEVICE_REFERENCE_SUGGESTION_MESSAGES,
  getDeviceReferenceSuggestionMessage
};
