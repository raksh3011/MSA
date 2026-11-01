// Local stand-in for wss://stream.aisstream.io so the live relay path can be tested without an API key.
// Usage: node scripts/mock-aisstream.mjs [port]   then run the Worker with AISSTREAM_URL=http://localhost:<port> and AISSTREAM_API_KEY=testkey
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 9911);
const wss = new WebSocketServer({ port });
const fleet = [
  { mmsi: 419100777, name: 'MV INDIAN TEST', lat: 15.2, lon: 72.0, sog: 12, cog: 90, type: 70 },
  { mmsi: 463100123, name: 'PAK TRADER', lat: 17.0, lon: 66.0, sog: 14, cog: 90, type: 70 },
  { mmsi: 419100888, name: 'FV KONKAN', lat: 16.0, lon: 71.0, sog: 4, cog: 200, type: 30 },
  { mmsi: 636100999, name: 'LIBERIA BULKER', lat: 12.9, lon: 46.0, sog: 11, cog: 70, type: 70 },
  { mmsi: 211000555, name: 'GERMAN BOX', lat: 1.4, lon: 103.9, sog: 9, cog: 300, type: 71 },
];

wss.on('connection', (ws) => {
  let timer;
  const t = setTimeout(() => ws.close(), 3000); // real service closes if no subscription within 3 s
  ws.once('message', (raw) => {
    clearTimeout(t);
    const sub = JSON.parse(String(raw));
    console.log('subscription:', JSON.stringify({ ...sub, APIKey: sub.APIKey ? '***' : undefined }));
    if (sub.APIKey !== 'testkey') {
      ws.send(JSON.stringify({ error: 'Api Key Is Not Valid' }));
      ws.close();
      return;
    }
    const send = () => {
      for (const v of fleet) {
        v.lat += (Math.cos((v.cog * Math.PI) / 180) * v.sog) / 3600;
        v.lon += (Math.sin((v.cog * Math.PI) / 180) * v.sog) / 3600;
        const meta = { MMSI: v.mmsi, ShipName: v.name, time_utc: new Date().toISOString().replace('T', ' ').replace('Z', ' +0000 UTC') };
        ws.send(JSON.stringify({ MessageType: 'ShipStaticData', MetaData: meta, Message: { ShipStaticData: { Name: v.name, Type: v.type } } }));
        ws.send(JSON.stringify({ MessageType: 'PositionReport', MetaData: meta, Message: { PositionReport: { Latitude: v.lat, Longitude: v.lon, Sog: v.sog, Cog: v.cog, TrueHeading: 511 } } }));
      }
    };
    send();
    timer = setInterval(send, 1000);
  });
  ws.on('close', () => clearInterval(timer));
});
console.log(`mock aisstream listening on ws://localhost:${port}`);
