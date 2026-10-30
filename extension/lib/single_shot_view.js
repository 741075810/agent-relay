// T122: the phrase for the restricted ("one message, fifteen minutes") grant.
//
// popup.js is a classic script and cannot import modules, so the popup would otherwise hold
// its own copy of the literal. Two copies of a phrase is how a popup ends up showing a phrase
// the worker refuses: the operator types what they see, gets `arm_confirmation_mismatch`, and
// has no way to tell that the UI is stale. This file holds the literal, popup.html loads it
// before popup.js, and `test_t095b122_single_shot.mjs` asserts it equals
// `autosend.SINGLE_SHOT_CONFIRM_PREFIX` so the two cannot drift apart silently.
(function expose() {
  'use strict';
  const PREFIX = 'AUTOSEND-ONCE ';
  // A phrase is shown only for a bound conversation; without one there is nothing to name.
  function phrase(conversationId) {
    return typeof conversationId === 'string' && conversationId
      ? PREFIX + conversationId : null;
  }
  const api = { SINGLE_SHOT_PREFIX: PREFIX, singleShotPhrase: phrase };
  if (typeof window !== 'undefined') {
    window.SINGLE_SHOT_PREFIX = PREFIX;
    window.singleShotPhrase = phrase;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
