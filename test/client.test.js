'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { once } = require('events');
const { DeakoClient } = require('../lib/client');

// Fake Deako hub: answers DEVICE_LIST, records every request, can push events.
function fakeHub(devices) {
  const received = [];
  let socket;
  let onConn;
  const connected = () => new Promise((r) => { onConn = r; });
  let next = connected();
  const server = net.createServer((s) => {
    socket = s;
    const resolve = onConn;
    next = connected();
    resolve();
    let buf = '';
    s.on('error', () => {}); // client hang-ups are expected
    s.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        const msg = JSON.parse(line);
        received.push(msg);
        if (msg.type === 'DEVICE_LIST') {
          for (const dev of devices) s.write(JSON.stringify({ type: 'DEVICE_FOUND', data: dev }) + '\r\n');
          s.write(JSON.stringify({ type: 'DEVICE_LIST', data: { number_of_devices: devices.length } }) + '\r\n');
        }
      }
    });
  });
  return {
    server,
    received,
    push: (msg) => socket.write(JSON.stringify(msg) + '\r\n'),
    kick: () => socket.destroy(),
  };
}

async function listen(hub) {
  hub.server.listen(0, '127.0.0.1');
  await once(hub.server, 'listening');
  return hub.server.address().port;
}

const DEVICES = [
  { uuid: 'a', name: 'Porch', capabilities: 'power', state: { power: false } },
  { uuid: 'b', name: 'Kitchen', capabilities: 'power+dim', state: { power: true, dim: 40 } },
];

test('lists devices and parses capabilities', async () => {
  const hub = fakeHub(DEVICES);
  const client = new DeakoClient({ host: '127.0.0.1', port: await listen(hub) });
  const found = [];
  client.on('device', (d) => found.push(d));
  client.start();
  while (found.length < 2) await once(client, 'device');
  assert.deepStrictEqual(found.map((d) => [d.name, d.capabilities]), [['Porch', ['power']], ['Kitchen', ['power', 'dim']]]);
  assert.deepStrictEqual(found[1].state, { power: true, dim: 40 });
  client.stop();
  hub.server.close();
});

test('control sends a CONTROL request in the pydeako format', async () => {
  const hub = fakeHub(DEVICES);
  const client = new DeakoClient({ host: '127.0.0.1', port: await listen(hub) });
  client.start();
  await once(client, 'connected');
  assert.strictEqual(client.control('b', true, 150.4), true);
  await new Promise((r) => setTimeout(r, 50));
  const ctl = hub.received.find((m) => m.type === 'CONTROL');
  assert.ok(ctl, 'CONTROL request received');
  assert.strictEqual(ctl.dst, 'deako');
  assert.ok(ctl.transactionId);
  assert.deepStrictEqual(ctl.data, { target: 'b', state: { power: true, dim: 100 } });
  client.stop();
  hub.server.close();
});

test('emits state on EVENT', async () => {
  const hub = fakeHub(DEVICES);
  const client = new DeakoClient({ host: '127.0.0.1', port: await listen(hub) });
  const hubSide = hub.nextClient;
  client.start();
  await Promise.all([once(client, 'connected'), hubSide]);
  hub.push({ type: 'EVENT', data: { target: 'a', state: { power: true } } });
  const [id, state] = await once(client, 'state');
  assert.strictEqual(id, 'a');
  assert.deepStrictEqual(state, { power: true });
  client.stop();
  hub.server.close();
});

test('handles messages split across TCP chunks', async () => {
  const client = new DeakoClient({ host: 'unused' });
  const states = [];
  client.on('state', (id, s) => states.push([id, s]));
  const line = JSON.stringify({ type: 'EVENT', data: { target: 'x', state: { power: false } } }) + '\r\n';
  client._onData(Buffer.from(line.slice(0, 10)));
  client._onData(Buffer.from(line.slice(10) + 'not json\r\n'));
  assert.deepStrictEqual(states, [['x', { power: false }]]);
});

test('control returns false while disconnected', () => {
  const client = new DeakoClient({ host: 'unused' });
  assert.strictEqual(client.control('a', true), false);
});

test('reconnects after the hub drops the connection', async () => {
  const hub = fakeHub(DEVICES);
  const client = new DeakoClient({ host: '127.0.0.1', port: await listen(hub), reconnectMs: 20 });
  client.on('error', () => {}); // ECONNRESET is expected when the hub drops us
  const hubSide = hub.nextClient;
  client.start();
  await Promise.all([once(client, 'connected'), hubSide]);
  const wait = (ev) => new Promise((r) => client.once(ev, r)); // events.once() rejects on 'error'
  const dropped = wait('disconnected');
  hub.kick();
  await dropped;
  await wait('connected');
  assert.strictEqual(client.connected, true);
  client.stop();
  hub.server.close();
});
