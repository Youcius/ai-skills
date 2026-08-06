'use strict';

const dns = require('dns');
const net = require('net');

const BLOCKED_HOSTNAMES = new Set([
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.google.internal',
]);

async function getSafeLookup(url, blockPrivate) {
  if (!blockPrivate) return undefined;

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || BLOCKED_HOSTNAMES.has(hostname)) {
    throw privateAddressError(hostname);
  }

  if (net.isIP(hostname)) {
    assertPublicAddress(hostname);
    return undefined;
  }

  const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) {
    const err = new Error(`No addresses found for ${hostname}`);
    err.code = 'ENOTFOUND';
    throw err;
  }
  for (const item of addresses) assertPublicAddress(item.address);
  return createPinnedLookup(addresses);
}

function createPinnedLookup(addresses) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    }

    const family = options && options.family;
    const matches = family ? addresses.filter((item) => item.family === family) : addresses;
    if (!matches.length) {
      const err = new Error(`No DNS address matching family ${family} for ${hostname}`);
      err.code = 'ENOTFOUND';
      callback(err);
      return;
    }

    if (options && options.all) {
      callback(null, matches.map((item) => ({ ...item })));
      return;
    }
    callback(null, matches[0].address, matches[0].family);
  };
}

function assertPublicAddress(address) {
  if (isPrivateAddress(address)) throw privateAddressError(address);
}

function privateAddressError(value) {
  const err = new Error(`Blocked private or local network address: ${value}`);
  err.code = 'ERR_PRIVATE_ADDRESS';
  return err;
}

function isPrivateAddress(address) {
  const value = stripIpv6Brackets(String(address).split('%')[0]).toLowerCase();
  const family = net.isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family !== 6) return true;

  const groups = parseIpv6(value);
  if (!groups) return true;
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xffc0) === 0xfec0) return true;
  if ((groups[0] & 0xff00) === 0xff00) return true;

  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isIpv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (isIpv4Mapped) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  if (isIpv4Compatible) return true;
  if (groups[0] === 0x2001 && (groups[1] === 0x0002 || groups[1] === 0x0db8)) return true;
  return false;
}

function parseIpv6(address) {
  let value = address;
  const dottedIpv4 = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedIpv4) {
    const parts = dottedIpv4[1].split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    const replacement = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    value = value.slice(0, -dottedIpv4[1].length) + replacement;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ].map((group) => parseInt(group, 16));
  if (groups.length !== 8 || groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) {
    return null;
  }
  return groups;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 2 || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function stripIpv6Brackets(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}

module.exports = { getSafeLookup, isPrivateAddress };
