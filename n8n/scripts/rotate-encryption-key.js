#!/usr/bin/env node
// Re-key an n8n 2.x SQLite database from one N8N_ENCRYPTION_KEY to another.
// n8n must be STOPPED (scale to 0) and the data folder backed up. Run it in a
// pod using the same n8n image, with the data folder mounted:
//   echo '{"old":"...","new":"..."}' | node rotate-encryption-key.js /home/node/.n8n/database.sqlite [--apply]
// Pass keys on stdin so they never appear in a command line. Without --apply
// everything runs inside a transaction that is rolled back. After applying,
// set "encryptionKey" in /home/node/.n8n/config to the new key, then start n8n.
// Verify with `n8n export:credentials --all --decrypted` before and after.
//
// What uses the instance key (n8n 2.49):
//  - deployment_key rows wrapped with AES-256-GCM under sha256(instanceKey)
//    (signing.*, data_encryption DEKs, oauth-server.signing-key, jwe.private-key);
//    older JWE rows may be CBC-wrapped with the instance key itself
//  - the legacy aes-256-cbc data_encryption row, whose payload IS the instance key
//  - "unprefixed" data encrypted with AES-256-CBC under the instance key
//    (credentials, MFA secrets, trusted_source config, source-control SSH key)
// Data with a "<keyId>:" prefix is encrypted with a DEK and needs no change.

const fs = require('fs');
const crypto = require('crypto');
const N8N = '/usr/local/lib/node_modules/n8n/node_modules';
const { CipherAes256GCM } = require(`${N8N}/n8n-core/dist/encryption/aes-256-gcm.js`);
const { CipherAes256CBC } = require(`${N8N}/n8n-core/dist/encryption/aes-256-cbc.js`);
const sqlite3 = require(`${N8N}/sqlite3`);

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');
const { old: OLD, new: NEW } = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!dbPath || !OLD || !NEW || OLD === NEW) throw new Error('usage: see header');
if (!/^[0-9a-f]{64}$/.test(NEW)) throw new Error('new key must be 64 hex chars');

const gcm = new CipherAes256GCM();
const cbc = new CipherAes256CBC();
const wrapKey = (k) => crypto.createHash('sha256').update(k).digest('hex');
const W_OLD = wrapKey(OLD);
const W_NEW = wrapKey(NEW);
const CBC_PREFIX = 'U2FsdGVkX1';

// Re-encrypt one unprefixed CBC blob, verifying the round trip.
function rekeyCbc(value) {
  const plain = cbc.decrypt(value, OLD);
  const out = cbc.encrypt(plain, NEW);
  if (cbc.decrypt(out, NEW) !== plain) throw new Error('CBC round trip failed');
  return out;
}
function rewrapGcm(plain) {
  const out = gcm.encrypt(plain, W_NEW);
  if (gcm.decrypt(out, W_NEW) !== plain) throw new Error('GCM round trip failed');
  return out;
}

const db = new sqlite3.Database(dbPath);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.changes); }));

async function main() {
  const log = [];
  await run('BEGIN IMMEDIATE');
  try {
    // 1. deployment_key
    for (const row of await all('SELECT id, type, algorithm, value FROM deployment_key')) {
      if (row.algorithm === null || row.algorithm === undefined || row.algorithm === '') {
        log.push(`deployment_key ${row.type}: plaintext, unchanged`);
        continue;
      }
      let plain;
      if (row.value.startsWith(CBC_PREFIX)) {
        plain = cbc.decrypt(row.value, OLD); // earlier CBC wrap with the instance key
      } else {
        plain = gcm.decrypt(row.value, W_OLD);
      }
      if (row.type === 'data_encryption' && row.algorithm === 'aes-256-cbc') {
        // Legacy descriptor: must keep resolving to the (new) instance key.
        if (plain !== OLD) throw new Error(`legacy DEK ${row.id} does not resolve to the old instance key`);
        plain = NEW;
      }
      await run('UPDATE deployment_key SET value = ? WHERE id = ?', [rewrapGcm(plain), row.id]);
      log.push(`deployment_key ${row.type} (${row.algorithm}, ${row.id}): re-wrapped`);
    }

    // 2. Unprefixed CBC blobs in plain columns
    const columns = [
      ['credentials_entity', 'id', 'data'],
      ['user', 'id', 'mfaSecret'],
      ['user', 'id', 'mfaRecoveryCodes'],
      ['trusted_source', 'id', 'config'],
    ];
    for (const [table, pk, col] of columns) {
      const rows = await all(`SELECT "${pk}" AS pk, "${col}" AS v FROM "${table}" WHERE "${col}" LIKE '${CBC_PREFIX}%'`);
      for (const r of rows) {
        await run(`UPDATE "${table}" SET "${col}" = ? WHERE "${pk}" = ?`, [rekeyCbc(r.v), r.pk]);
      }
      log.push(`${table}.${col}: ${rows.length} re-encrypted`);
    }

    // 3. Source-control SSH key (JSON inside settings)
    const [ssh] = await all(`SELECT value FROM settings WHERE key = 'features.sourceControl.sshKeys'`);
    if (ssh) {
      const v = JSON.parse(ssh.value);
      if (typeof v.encryptedPrivateKey === 'string' && v.encryptedPrivateKey.startsWith(CBC_PREFIX)) {
        v.encryptedPrivateKey = rekeyCbc(v.encryptedPrivateKey);
        await run(`UPDATE settings SET value = ? WHERE key = 'features.sourceControl.sshKeys'`, [JSON.stringify(v)]);
        log.push('settings sshKeys: re-encrypted');
      }
    }

    // 4. Safety net: any CBC blob anywhere that still only decrypts with the old key?
    const leftovers = [];
    for (const { name: t } of await all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
      for (const { name: c } of await all(`SELECT name FROM pragma_table_info('${t}')`)) {
        const rows = await all(`SELECT "${c}" AS v FROM "${t}" WHERE typeof("${c}")='text' AND "${c}" LIKE '%${CBC_PREFIX}%'`);
        for (const { v } of rows) {
          for (const m of v.match(/U2FsdGVkX1[A-Za-z0-9+/=]+/g) || []) {
            let oldOk = false, newOk = false;
            try { cbc.decrypt(m, OLD); oldOk = true; } catch {}
            try { cbc.decrypt(m, NEW); newOk = true; } catch {}
            if (oldOk && !newOk) leftovers.push(`${t}.${c}`);
          }
        }
      }
    }
    if (leftovers.length) throw new Error(`still encrypted with the old key: ${[...new Set(leftovers)].join(', ')}`);
    log.push('safety scan: no data left under the old key');

    await run(apply ? 'COMMIT' : 'ROLLBACK');
    log.push(apply ? 'COMMITTED' : 'DRY RUN: rolled back');
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    console.log(log.join('\n'));
    db.close();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
