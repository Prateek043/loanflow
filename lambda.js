// AWS Lambda Function URL / API Gateway HTTP API payload v2 adapter.
const { handler: app } = require('./server');

exports.handler = (event) => new Promise((resolve, reject) => {
  if (event.version !== '2.0') {
    reject(new Error('Expected an AWS HTTP payload version 2.0 event'));
    return;
  }

  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (event.cookies?.length) headers.cookie = event.cookies.join('; ');
  headers.host ||= event.requestContext?.domainName || 'localhost';
  headers['x-forwarded-proto'] ||= 'https';

  const body = event.body || '';
  const req = {
    method: event.requestContext?.http?.method || event.requestContext?.httpMethod,
    url: (event.rawPath || '/') + (event.rawQueryString ? `?${event.rawQueryString}` : ''),
    headers,
    body: event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body,
    socket: { remoteAddress: event.requestContext?.http?.sourceIp || '' },
  };

  let statusCode = 200;
  const responseHeaders = {};
  const chunks = [];
  const res = {
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    writeHead(status, headersToSet = {}) {
      statusCode = status;
      for (const [name, value] of Object.entries(headersToSet)) this.setHeader(name, value);
    },
    write(chunk) { if (chunk != null) chunks.push(Buffer.from(chunk)); },
    end(chunk) {
      this.write(chunk);
      const data = Buffer.concat(chunks);
      const contentType = responseHeaders['content-type'] || '';
      const isText = /^(text\/|application\/(json|javascript|xml))/.test(contentType);
      const cookies = responseHeaders['set-cookie'];
      delete responseHeaders['set-cookie'];
      resolve({
        statusCode,
        headers: responseHeaders,
        ...(cookies ? { cookies: Array.isArray(cookies) ? cookies : [cookies] } : {}),
        body: data.toString(isText ? 'utf8' : 'base64'),
        isBase64Encoded: !isText,
      });
    },
  };

  Promise.resolve(app(req, res)).catch(reject);
});
