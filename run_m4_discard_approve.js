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
  const loginBody = JSON.stringify({ email: "admin@hospital.demo", password: "hospitalAdmin123" });
  const loginRes = await post('/api/auth/login', loginBody);
  const token = JSON.parse(loginRes.body).token;
  fs.writeFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token_hospital.txt', token);

  // First request - should get needs_confirmation
  const chatBody = JSON.stringify({
    sessionId: "live-m4-discard-approve",
    appId: "hospital",
    message: "Discard expired stock for Aspirin"
  });
  const chatRes = await post('/api/agent/chat', chatBody, token);
  const j = JSON.parse(chatRes.body);
  console.log('First request status:', j.status);
  console.log('pendingConfirmation:', JSON.stringify(j.pendingConfirmation));
  
  if (j.pendingConfirmation) {
    const confId = j.pendingConfirmation.confirmationId;
    
    // Step 2: User APPROVES (approve: true)
    const confirmBody = JSON.stringify({
      sessionId: "live-m4-discard-approve",
      appId: "hospital",
      confirmationId: confId,
      approve: true
    });
    const confirmRes = await post('/api/agent/confirm', confirmBody, token);
    console.log('\nConfirm HTTP ' + confirmRes.status);
    const j2 = JSON.parse(confirmRes.body);
    console.log('status=' + j2.status);
    console.log('answer=' + JSON.stringify(j2.answer));
    console.log('steps=' + JSON.stringify(j2.steps?.map(s => ({tool: s.tool, status: s.status, summary: s.summary}))));
  }
}

main().catch(console.error);