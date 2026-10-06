const http = require('http');
const fs = require('fs');
const token = fs.readFileSync('C:\\Users\\sunil\\AppData\\Local\\Temp\\kilo\\token.txt','utf8').trim();

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
  const list = await get('/api/traces?appId=hospital&limit=3');
  const traces = Array.isArray(list) ? list : (list.traces || list.items || []);
  if (traces.length > 0) {
    const t = traces[0];
    const detail = await get('/api/traces/' + t.traceId);
    console.log('traceId=' + t.traceId + ' status=' + t.status);
    console.log('steps=' + JSON.stringify(detail.turns?.map(turn => turn.steps?.map(s => ({tool: s.tool, status: s.status}))) || []));
    console.log('answer=' + JSON.stringify(detail.answer));
  } else {
    console.log('no traces: ' + JSON.stringify(list).slice(0,300));
  }
})();