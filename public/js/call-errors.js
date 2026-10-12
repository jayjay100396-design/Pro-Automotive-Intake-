// What a failed call to a server function (callFunction in firebase.js) means, for the words the person sees.
// Firebase adds the HTTP status to every callable error's message ("Pick the supplier first. [400]"), so people get
// the sentence without it. A call no function answered (not deployed yet, no connection) has no sentence at all: the
// message is just the code, "internal [0]" or "not-found [404]". Plain functions, unit tested in test/call-errors.test.mjs.

export const codeOf = (e) => String(e?.code || '').replace(/^functions\//, '');

export const messageOf = (e) => String(e?.message || '').replace(/\s*\[\d{1,3}\]$/, '');

// The function's own sentence, or '' when there's none: a bare code Firebase made ("internal", "deadline-exceeded"
// when the app stopped waiting), or "INTERNAL" from a function that failed without saying why.
export function sentenceOf(e) {
  const code = codeOf(e);
  const message = messageOf(e);
  return message === code || message === code.toUpperCase().replace(/-/g, '_') ? '' : message;
}

// True when no function answered the call: it isn't deployed yet, there's no connection, or it was cut off. A function's
// own answer with the same code ("This parts request was deleted.", or "INTERNAL") isn't counted.
export function noAnswer(e) {
  const code = codeOf(e);
  return ['internal', 'not-found', 'unimplemented'].includes(code) && ['', code].includes(messageOf(e));
}
