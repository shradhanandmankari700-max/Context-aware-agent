const http = require('http');
const fs = require('fs');
const token = fs.readFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token.txt','utf8').trim();

function post(path, body) {
  return new Promise((resolve, reject) => {
    const headers = {'Content-Type':'application/json','Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + token};
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
  // M3-3: "Compare this month's medicine usage with last month."
  const chatBody = JSON.stringify({
    sessionId: "live-m33",
    appId: "hospital",
    message: "Compare this month's medicine usage with last month."
  });
  const chatRes = await post('/api/agent/chat', chatBody);
  console.log('CHAT HTTP ' + chatRes.status);
  try {
    const j = JSON.parse(chatRes.body);
    console.log('status=' + j.status);
    console.log('steps=' + JSON.stringify(j.steps?.map(s => ({tool: s.tool, status: s.status, summary: s.summary}))));
    console.log('answer=' + JSON.stringify(j.answer));
  } catch(e) { console.log('parse error: ' + e.message); console.log(chatRes.body.slice(0,500)); }
}

main().catch(console.error);