// What a failed call to a server function shows (public/js/call-errors.js), with errors made by the real Firebase
// library the app loads (12.19.0): a call nothing answers, a server that answers with a sentence, a function that
// failed without saying why, and a call the app stopped waiting for. Needs nothing running; it starts its own small server.
import assert from 'node:assert/strict';
import http from 'node:http';
import { initializeApp, deleteApp } from 'firebase/app';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { codeOf, messageOf, sentenceOf, noAnswer } from '../public/js/call-errors.js';

// Answers every call with this HTTP status and body.
const answering = (httpStatus, body, type = 'application/json') => http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(httpStatus, { 'Content-Type': type });
    res.end(body);
  });
});
// How a callable function refuses, with a sentence for the person (or "INTERNAL" when it threw something else).
const refusal = (status, message) => JSON.stringify({ error: { status, message } });
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

describe('Server function errors in words', () => {
  let app;
  before(() => { app = initializeApp({ projectId: 'demo-stellar-glass', apiKey: 'test', appId: 'test' }, 'call-errors'); });
  after(() => deleteApp(app));

  // The error the app gets from a call to sendPartsEmail on a server at this port.
  const failedCall = async (port, timeout = 10000) => {
    const functions = getFunctions(app, 'us-central1');
    connectFunctionsEmulator(functions, '127.0.0.1', port);
    try {
      await httpsCallable(functions, 'sendPartsEmail', { timeout })({ companyId: 'c1', requestId: 'r1' });
    } catch (e) {
      return e;
    }
    throw new Error('the call should have failed');
  };

  it('counts a call nothing answers as no answer, as before sendPartsEmail is deployed', async () => {
    const server = http.createServer();
    const port = await listen(server);
    await close(server); // Nothing listens there now, like a function that doesn't exist yet.
    const e = await failedCall(port);
    assert.equal(e.code, 'functions/internal');
    assert.equal(e.message, 'internal [0]', 'Firebase 12.19.0 adds the status to the message');
    assert.equal(messageOf(e), 'internal');
    assert.equal(sentenceOf(e), '');
    assert.ok(noAnswer(e));
  });

  it('shows the server\'s sentence without the status Firebase adds', async () => {
    const sentence = 'The app has sent 40 supplier emails today, the most it sends in a day. Use Open in Gmail, or send it tomorrow.';
    const server = answering(429, refusal('RESOURCE_EXHAUSTED', sentence));
    const port = await listen(server);
    try {
      const e = await failedCall(port);
      assert.equal(e.message, `${sentence} [429]`);
      assert.equal(codeOf(e), 'resource-exhausted');
      assert.equal(sentenceOf(e), sentence);
      assert.equal(noAnswer(e), false);
    } finally {
      await close(server);
    }
  });

  it('keeps a sentence the server sends with "not found", which isn\'t a missing function', async () => {
    const server = answering(404, refusal('NOT_FOUND', 'This parts request was deleted.'));
    const port = await listen(server);
    try {
      const e = await failedCall(port);
      assert.equal(codeOf(e), 'not-found');
      assert.equal(sentenceOf(e), 'This parts request was deleted.');
      assert.equal(noAnswer(e), false);
    } finally {
      await close(server);
    }
  });

  it('counts a bare "not found" page, with no sentence, as no answer', async () => {
    const server = answering(404, '<html><body>Page not found</body></html>', 'text/html');
    const port = await listen(server);
    try {
      const e = await failedCall(port);
      assert.equal(e.message, 'not-found [404]');
      assert.equal(sentenceOf(e), '');
      assert.ok(noAnswer(e));
    } finally {
      await close(server);
    }
  });

  it('has no sentence, but an answer, when the function failed without saying why', async () => {
    // What onCall sends when the function throws something that isn't an HttpsError.
    const server = answering(500, refusal('INTERNAL', 'INTERNAL'));
    const port = await listen(server);
    try {
      const e = await failedCall(port);
      assert.equal(e.message, 'INTERNAL [500]');
      assert.equal(codeOf(e), 'internal');
      assert.equal(sentenceOf(e), '');
      assert.equal(noAnswer(e), false, 'the function is there, so it isn\'t "not set up"');
    } finally {
      await close(server);
    }
  });

  it('has no sentence when the app stops waiting', async () => {
    const server = http.createServer(() => {}); // Takes the call and never answers.
    const port = await listen(server);
    try {
      const e = await failedCall(port, 200);
      assert.equal(codeOf(e), 'deadline-exceeded');
      assert.equal(sentenceOf(e), '');
      assert.equal(noAnswer(e), false);
    } finally {
      await close(server);
    }
  });

  it('handles plain values too', () => {
    assert.equal(messageOf({ message: 'Pick the supplier first. [400]' }), 'Pick the supplier first.');
    assert.equal(messageOf({ message: 'Costs [about] $40' }), 'Costs [about] $40', 'only a trailing status goes');
    assert.equal(messageOf(undefined), '');
    assert.equal(sentenceOf(undefined), '');
    assert.equal(codeOf({ code: 'functions/unauthenticated' }), 'unauthenticated');
    assert.equal(noAnswer({ code: 'functions/internal', message: '' }), true);
    assert.equal(noAnswer({ code: 'functions/internal', message: 'The email didn\'t go out. Try again, or use Open in Gmail. [500]' }), false);
    assert.equal(noAnswer({ code: 'functions/permission-denied', message: 'permission-denied [403]' }), false);
    assert.equal(sentenceOf({ code: 'functions/resource-exhausted', message: 'RESOURCE_EXHAUSTED [429]' }), '');
  });
});
