'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

/**
 * Client for the Deako local integration API.
 *
 * Protocol: newline-delimited JSON over TCP (port 23).
 *   request:  { transactionId, dst: 'deako', src, type, data? }
 *   types:    DEVICE_LIST, CONTROL, PING
 *   replies:  DEVICE_FOUND (one per device), DEVICE_LIST (summary), EVENT (state change)
 *
 * The hub accepts one client at a time, so this client holds a single
 * persistent connection and reconnects when it drops.
 *
 * Events: 'connected', 'disconnected', 'device' ({uuid, name, capabilities, state}),
 *         'state' (uuid, state), 'error' (err)
 */
class DeakoClient extends EventEmitter {
  constructor({ host, port = 23, source = 'homebridge-deako', reconnectMs = 10000, pingMs = 30000, resyncMs = 300000 } = {}) {
    super();
    if (!host) throw new Error('host is required');
    Object.assign(this, { host, port, source, reconnectMs, pingMs, resyncMs });
    this.sock = null;
    this.buf = '';
    this.stopped = true;
    this.timers = [];
  }

  get connected() {
    return !!this.sock && !this.sock.destroyed && this.sock.readyState === 'open';
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    clearTimeout(this.reconnectTimer);
    if (this.sock) this.sock.destroy();
  }

  requestDeviceList() {
    return this.send('DEVICE_LIST');
  }

  /** @param {string} uuid @param {boolean} power @param {number} [dim] 0-100 */
  control(uuid, power, dim) {
    const state = { power: !!power };
    if (typeof dim === 'number') state.dim = Math.max(0, Math.min(100, Math.round(dim)));
    return this.send('CONTROL', { target: uuid, state });
  }

  send(type, data) {
    if (!this.connected) return false;
    const msg = { transactionId: randomUUID(), dst: 'deako', src: this.source, type };
    if (data !== undefined) msg.data = data;
    this.sock.write(JSON.stringify(msg) + '\r\n');
    return true;
  }

  _connect() {
    if (this.stopped) return;
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.sock = sock;
    sock.setKeepAlive(true, 30000);

    sock.on('connect', () => {
      this.buf = '';
      this._clearTimers();
      this.timers.push(setInterval(() => this.send('PING'), this.pingMs));
      this.timers.push(setInterval(() => this.requestDeviceList(), this.resyncMs));
      this.emit('connected');
      this.requestDeviceList();
    });
    sock.on('data', (chunk) => this._onData(chunk));
    // Never crash the host: an unhandled 'error' event would throw. 'close' follows and reconnects.
    sock.on('error', (err) => { if (this.listenerCount('error') > 0) this.emit('error', err); });
    sock.on('close', () => {
      this._clearTimers();
      if (this.sock === sock) this.sock = null;
      this.emit('disconnected');
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this._connect(), this.reconnectMs);
    });
  }

  _onData(chunk) {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      const text = line.trim();
      if (text) this._onMessage(text);
    }
  }

  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const data = msg.data || {};
    if (msg.type === 'DEVICE_FOUND' && data.uuid) {
      this.emit('device', {
        uuid: data.uuid,
        name: data.name || data.uuid,
        capabilities: String(data.capabilities || '').split('+').filter(Boolean),
        state: data.state || {},
      });
    } else if (msg.type === 'EVENT' && data.target) {
      this.emit('state', data.target, data.state || {});
    }
  }

  _clearTimers() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }
}

module.exports = { DeakoClient };
