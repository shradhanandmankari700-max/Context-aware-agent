const http = require('http');
const fs = require('fs');
const token = fs.readFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token_hotel.txt','utf8').trim();

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 4000, path, method: 'GET', headers: {'Authorization': 'Bearer ' + token} };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const list = await get('/api/traces?appId=hotel&limit=5');
  console.log('Trace list:', JSON.stringify(list, null, 2));
  const traces = Array.isArray(list) ? list : (list.traces || list.items || []);
  if (traces.length > 0) {
    // Find the latest trace for session live-m34-fresh
    const freshTrace = traces.find(t => t.sessionId === 'live-m34-fresh') || traces[0];
    const detail = await get('/api/traces/' + freshTrace.traceId);
    console.log('\nLatest trace for live-m34-fresh:');
    console.log(JSON.stringify(detail, null, 2));
  } else {
    console.log('no traces');
  }
})();