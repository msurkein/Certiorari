'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mappings = require('../src/main/mappings');

test('canonicalizeUrl: adds https, lowercases, strips path/query/hash', () => {
  assert.equal(mappings.canonicalizeUrl('Site.Example.com/app/login?x=1#h'), 'https://site.example.com');
});

test('canonicalizeUrl: drops default ports', () => {
  assert.equal(mappings.canonicalizeUrl('https://site.example.com:443/x'), 'https://site.example.com');
  assert.equal(mappings.canonicalizeUrl('http://site.example.com:80'), 'http://site.example.com');
});

test('canonicalizeUrl: keeps non-default port', () => {
  assert.equal(mappings.canonicalizeUrl('https://site.example.com:8443'), 'https://site.example.com:8443');
});

test('canonicalizeUrl: empty / invalid -> empty string', () => {
  assert.equal(mappings.canonicalizeUrl(''), '');
  assert.equal(mappings.canonicalizeUrl('http://'), '');
});

test('GLOBAL_KEY is "*"', () => {
  assert.equal(mappings.GLOBAL_KEY, '*');
});
