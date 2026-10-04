// Loaded with NODE_OPTIONS=--require <this file> (scripts/test-offline.mjs): records every name lookup and every
// TCP or UDP connection a Node process starts towards an address that is not this machine, one JSON line each in
// $DQL_NETWORK_LOG. Lookups are recorded too because they fail before a socket exists, so sampling sockets alone
// cannot see them. Nothing is blocked: the record is read after the run.
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const out = process.env.DQL_NETWORK_LOG;
const LOOPBACK = /^(127\.|::1$|::ffff:127\.|localhost$|0\.0\.0\.0$|::$)/i;
if (out) { try { fs.appendFileSync(out, `${JSON.stringify({ pid: process.pid, kind: 'start' })}\n`); } catch {} }
function record(kind, host, port) {
  if (!out) return;
  const name = host === undefined || host === null || host === '' ? 'localhost' : String(host);
  if (LOOPBACK.test(name) || name.endsWith('.localhost')) return;
  let stack = '';
  try { stack = new Error().stack.split('\n').slice(3, 9).map((line) => line.trim()).join(' | '); } catch {}
  try { fs.appendFileSync(out, `${JSON.stringify({ pid: process.pid, argv: process.argv.slice(1, 3).join(' ').slice(-160), kind, host: name, port, stack })}\n`); } catch {}
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function recordedConnect(...args) {
  try {
    let options = args[0];
    if (Array.isArray(options)) options = options[0];
    if (options && typeof options === 'object') { if (!options.path) record('tcp', options.host, options.port); }
    else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) record('tcp', typeof args[1] === 'string' ? args[1] : 'localhost', options);
  } catch {}
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function recordedLookup(hostname, ...rest) { try { record('dns.lookup', hostname); } catch {} return lookup.call(this, hostname, ...rest); };
if (dns.promises && dns.promises.lookup) {
  const promised = dns.promises.lookup;
  dns.promises.lookup = function recordedPromisedLookup(hostname, ...rest) { try { record('dns.promises.lookup', hostname); } catch {} return promised.call(this, hostname, ...rest); };
}
for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveAny']) {
  const original = dns[name];
  if (typeof original === 'function') dns[name] = function recordedResolve(hostname, ...rest) { try { record(`dns.${name}`, hostname); } catch {} return original.call(this, hostname, ...rest); };
}
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function recordedSend(...args) {
  try { record('udp', args.find((arg, index) => index > 0 && typeof arg === 'string'), args.find((arg, index) => index > 0 && typeof arg === 'number')); } catch {}
  return send.apply(this, args);
};
