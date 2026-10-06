const http = require('http');
const fs = require('fs');

function post(path, body, token) {
  return new Promise((resolve, reject) => {
    const headers = {'Content-Type':'application/json','Content-Length': Buffer.byteLength(body)};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const opts = { hostname: 'localhost', port: 4000, path, method: 'POST', headers };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  const loginBody = fs.readFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\login_body.json','utf8');
  const loginRes = await post('/api/auth/login', loginBody);
  const token = JSON.parse(loginRes.body).token;
  fs.writeFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token.txt', token);

  // M3-2: Follow-up question - "Show me the ones that may run out within two days."
  const chatBody = JSON.stringify({
    sessionId: "live-m31-attempt5",  // Same session as M3-1 to maintain context
    appId: "hospital",
    message: "Show me the ones that may run out within two days."
  });
  const chatRes = await post('/api/agent/chat', chatBody, token);
  fs.writeFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\m32_response.json', chatRes.body);
  console.log('CHAT HTTP ' + chatRes.status);
  try {
    const j = JSON.parse(chatRes.body);
    console.log('status=' + j.status);
    console.log('steps=' + JSON.stringify(j.steps?.map(s => ({tool: s.tool, status: s.status, summary: s.summary}))));
    console.log('answer=' + JSON.stringify(j.answer));
  } catch(e) { console.log('parse error: ' + e.message); console.log(chatRes.body.slice(0,500)); }
}

main().catch(console.error);