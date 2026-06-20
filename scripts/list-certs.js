'use strict';

/**
 * Standalone cert dump — runs the SAME enumeration the app uses, without
 * launching Electron. Handy for verifying your store and tuning deriveCertLabel.
 *
 *   node scripts/list-certs.js
 */

const certs = require('../src/main/certs');

try {
  const list = certs.listCertificates();
  if (!list.length) {
    console.log('No certificates with a private key found in:', certs.STORE_PATHS.join(', '));
    process.exit(0);
  }
  console.log(`Found ${list.length} certificate(s):\n`);
  for (const c of list) {
    console.log(`• ${c.label}`);
    console.log(`    ${c.sublabel}`);
    console.log(`    subject:    ${c.subject}`);
    console.log(`    thumbprint: ${c.thumbprint}`);
    console.log(`    serial:     ${c.serialNumber}`);
    console.log(`    EKU:        ${(c.eku || []).join(', ') || '(none)'}`);
    console.log('');
  }
} catch (err) {
  console.error('Enumeration failed:', err.message);
  process.exit(1);
}
