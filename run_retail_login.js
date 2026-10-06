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
  // Login as retail admin (need to check if there's a retail admin user)
  const loginBody = JSON.stringify({ email: "admin@retail.demo", password: "retailAdmin123" });
  const loginRes = await post('/api/auth/login', loginBody);
  console.log('LOGIN HTTP', loginRes.status);
  if (loginRes.status !== 200) {
    console.log('Login failed, trying hospital admin...');
    // Try hospital admin with retail appId
    const loginBody2 = JSON.stringify({ email: "admin@hospital.demo", password: "hospitalAdmin123" });
    const loginRes2 = await post('/api/auth/login', loginBody2);
    const token = JSON.parse(loginRes2.body).token;
    fs.writeFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token_retail.txt', token);
  } else {
    const token = JSON.parse(loginRes.body).token;
    fs.writeFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token_retail.txt', token);
  }
}

main().catch(console.error);