// Migrate IndexedDB data from Edge to Electron
// Reads Edge's LevelDB and blob files, writes into a JS-accessible format
const { ClassicLevel } = require('classic-level');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EDGE_DB_PATH = path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/Default/IndexedDB/file__0.indexeddb.leveldb');
const EDGE_BLOB_PATH = path.join(os.homedir(), 'Library/Application Support/Microsoft Edge/Default/IndexedDB/file__0.indexeddb.blob');
const OUTPUT_PATH = path.join(__dirname, 'migration-data');

async function main() {
  console.log('Opening Edge LevelDB at:', EDGE_DB_PATH);

  try {
    const db = new ClassicLevel(EDGE_DB_PATH, { readOnly: true });
    await db.open();
    console.log('LevelDB opened successfully');

    let count = 0;
    const entries = [];

    // Read all entries
    for await (const [key, value] of db.iterator()) {
      count++;
      const keyStr = Buffer.isBuffer(key) ? key.toString('hex') : String(key);
      const valHex = Buffer.isBuffer(value) ? value.toString('hex').slice(0, 100) : String(value).slice(0, 100);
      const valLen = Buffer.isBuffer(value) ? value.length : String(value).length;

      entries.push({ key: keyStr, len: valLen, preview: valHex });

      if (count <= 30) {
        console.log(`  Entry ${count}: key=${keyStr.slice(0,40)}, len=${valLen}, preview=${valHex.slice(0,60)}`);
      }
    }

    console.log(`Total entries: ${count}`);

    // Save metadata about entries
    if (!fs.existsSync(OUTPUT_PATH)) {
      fs.mkdirSync(OUTPUT_PATH, { recursive: true });
    }
    fs.writeFileSync(path.join(OUTPUT_PATH, 'leveldb-entries.json'), JSON.stringify(entries, null, 2));
    console.log('Entry metadata saved to migration-data/leveldb-entries.json');

    await db.close();

    // Also list blob files
    if (fs.existsSync(EDGE_BLOB_PATH)) {
      console.log('\nBlob storage files:');
      const blobFiles = [];
      function walkDir(dir, prefix) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            walkDir(full, path.join(prefix, item));
          } else {
            const mb = (stat.size / 1024 / 1024).toFixed(1);
            blobFiles.push({ path: path.join(prefix, item), size: stat.size });
            console.log(`  ${mb} MB  ${path.join(prefix, item)}`);
          }
        }
      }
      walkDir(EDGE_BLOB_PATH, '');
      fs.writeFileSync(path.join(OUTPUT_PATH, 'blob-files.json'), JSON.stringify(blobFiles, null, 2));
    }

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  }
}

main();
