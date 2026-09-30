const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters';
const { handler } = require('../lambda');

function event(method, rawPath, { body, cookie, rawQueryString = '' } = {}) {
  return {
    version: '2.0', rawPath, rawQueryString,
    headers: { host: 'example.lambda-url.us-east-1.on.aws', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(cookie ? { cookies: [cookie] } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
    requestContext: { http: { method, sourceIp: '192.0.2.1' } },
  };
}

test('Lambda serves the page and protects the API', async () => {
  const page = await handler(event('GET', '/'));
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body, /id="login"/);

  const unauthenticated = await handler(event('GET', '/api/me'));
  assert.equal(unauthenticated.statusCode, 401);
  assert.deepEqual(JSON.parse(unauthenticated.body), { error: 'Please sign in' });

  const missing = await handler(event('GET', '/missing.js'));
  assert.equal(missing.statusCode, 404);
});

test('Lambda passes JSON login and cookies through the shared handler', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ login: 'tester', name: 'Tester' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  t.after(() => { global.fetch = originalFetch; });

  const login = await handler(event('POST', '/api/login', {
    body: { username: 'tester', password: 'password' },
  }));
  assert.equal(login.statusCode, 200);
  assert.match(login.cookies[0], /HttpOnly/);
  assert.match(login.cookies[0], /Secure/);

  const cookie = login.cookies[0].split(';')[0];
  const me = await handler(event('GET', '/api/me', { cookie }));
  assert.deepEqual(JSON.parse(me.body).user, { login: 'tester', name: 'Tester', email: '' });

  const logout = await handler(event('POST', '/api/logout', { cookie }));
  assert.equal(logout.statusCode, 200);
  assert.match(logout.cookies[0], /Max-Age=0/);
});

test('Lambda accepts encoded JSON request bodies', async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('{}', { status: 401 });
  t.after(() => { global.fetch = originalFetch; });
  const login = event('POST', '/api/login');
  login.headers['content-type'] = 'application/json';
  login.body = Buffer.from(JSON.stringify({ username: 'tester', password: 'bad' })).toString('base64');
  login.isBase64Encoded = true;
  const response = await handler(login);
  assert.equal(response.statusCode, 401);
});
