// Checks the credential vault does what its comments claim.
//
// Encryption code that "works" is easy to write and hard to trust: a version that returns the
// input unchanged would pass a naive round-trip test. So these check the properties that matter
// — that ciphertext differs from plaintext, that a repeated encryption is not identical, that
// tampering is detected rather than absorbed, and that nothing secret survives into a log line.
process.env.DB_PATH = process.env.DB_PATH || 'data/vault-test.db';
process.env.CREDENTIAL_KEY = process.env.CREDENTIAL_KEY
  || require('crypto').randomBytes(32).toString('hex');

const vault = require('../services/security/vault');

let pass = 0; let fail = 0;
function is(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
}

const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

console.log('\n  round trip');
{
  const enc = vault.encrypt(SECRET);
  is('decrypts back to the original', vault.decrypt(enc) === SECRET);
  is('ciphertext does not contain the plaintext', !enc.includes(SECRET), enc.slice(0, 60));
  is('is versioned', enc.startsWith('v1.'), enc.slice(0, 12));
  is('null in, null out', vault.encrypt(null) === null && vault.decrypt(null) === null);
  is('empty string is treated as nothing to store', vault.encrypt('') === null);
}

console.log('\n  a fresh IV every time');
{
  const a = vault.encrypt(SECRET);
  const b = vault.encrypt(SECRET);
  // Identical ciphertexts would mean a fixed IV, which breaks GCM outright.
  is('same input encrypts differently twice', a !== b);
  is('both still decrypt correctly', vault.decrypt(a) === SECRET && vault.decrypt(b) === SECRET);
  const ivA = a.split('.')[1];
  const ivB = b.split('.')[1];
  is('the IVs actually differ', ivA !== ivB, `${ivA} vs ${ivB}`);
  is('IV is 96 bits', ivA.length === 24, `${ivA.length} hex chars`);
}

console.log('\n  tampering is detected, not absorbed');
{
  const enc = vault.encrypt(SECRET);
  const [v, iv, tag, data] = enc.split('.');

  // Flip one hex digit of the ciphertext.
  const flipped = data.slice(0, -1) + (data.slice(-1) === 'a' ? 'b' : 'a');
  let threw = false;
  try { vault.decrypt([v, iv, tag, flipped].join('.')); } catch (e) { threw = e.code === 'DECRYPT_FAILED'; }
  is('altered ciphertext is rejected', threw);

  let tagThrew = false;
  const badTag = tag.slice(0, -1) + (tag.slice(-1) === 'a' ? 'b' : 'a');
  try { vault.decrypt([v, iv, badTag, data].join('.')); } catch (e) { tagThrew = e.code === 'DECRYPT_FAILED'; }
  is('altered auth tag is rejected', tagThrew);

  let shapeThrew = false;
  try { vault.decrypt('not-a-real-ciphertext'); } catch (e) { shapeThrew = e.code === 'BAD_CIPHERTEXT'; }
  is('a malformed record is rejected by shape', shapeThrew);
}

console.log('\n  a different key cannot read it');
{
  const enc = vault.encrypt(SECRET);
  // Reload the module under a different key, the way a deployment with the wrong .env would.
  delete require.cache[require.resolve('../services/security/vault')];
  delete require.cache[require.resolve('../config/env')];
  process.env.CREDENTIAL_KEY = require('crypto').randomBytes(32).toString('hex');
  const other = require('../services/security/vault');
  let threw = false;
  try { other.decrypt(enc); } catch (e) { threw = e.code === 'DECRYPT_FAILED'; }
  is('ciphertext from another key fails to decrypt', threw);
  is('and does not return garbage instead', threw);
}

console.log('\n  masking and log redaction');
{
  is('mask keeps only the last four', vault.mask('8fe6e2aaaabbbbccccddddeeeeffb20d') === '••••b20d');
  is('a short value is fully masked', vault.mask('abc') === '••••');

  const line = vault.redact({
    path: '/trades',
    api_key: SECRET,
    apiSecret: SECRET,
    session_token: SECRET,
    nested: { access_token: SECRET, symbol: 'RELIANCE' },
    headers: { 'X-AppKey': SECRET, 'X-Timestamp': '2026-09-01' },
  });
  const text = JSON.stringify(line);
  is('no secret survives redaction', !text.includes(SECRET), text.slice(0, 140));
  is('non-secret fields are kept', text.includes('RELIANCE') && text.includes('/trades'));
  is('nested secrets are caught too', line.nested.access_token === '[redacted]');
  is('header-style keys are caught', line.headers['X-AppKey'] === '[redacted]');
  is('a timestamp is not mistaken for a secret', line.headers['X-Timestamp'] === '2026-09-01');
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
