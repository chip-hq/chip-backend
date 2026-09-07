import { MongoClient } from 'mongodb';
import dns from 'node:dns';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'chip';

if (!uri) {
  console.error('Error: MONGODB_URI not set in backend/.env');
  process.exit(1);
}

const dnsServers = process.env.MONGODB_DNS_SERVERS;
if (dnsServers) {
  const servers = dnsServers.split(',').map((s) => s.trim()).filter(Boolean);
  if (servers.length) {
    dns.setServers(servers);
  }
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000,
  tls: process.env.MONGODB_SSL !== 'false',
});

async function main() {
  try {
    console.log(`Connecting to MongoDB Atlas (database: ${dbName})...`);
    await client.connect();
    const db = client.db(dbName);
    console.log('Connected successfully.\n');

    // 1. Inspect existing counts
    const projectsCount = await db.collection('projects').countDocuments();
    const versionsCount = await db.collection('circuit_versions').countDocuments();
    const circuitsCount = await db.collection('circuits').countDocuments();

    console.log('Current Database Status:');
    console.log(`- projects: ${projectsCount}`);
    console.log(`- circuit_versions: ${versionsCount}`);
    console.log(`- circuits: ${circuitsCount}`);

    if (projectsCount > 0) {
      const sampleProjects = await db.collection('projects').find({}, { projection: { id: 1, name: 1, userId: 1 } }).toArray();
      console.log('\nProjects to be deleted:');
      sampleProjects.forEach((p) => console.log(`  - [${p.id || p._id}] "${p.name || ''}" (user: ${p.userId || 'unknown'})`));
    }

    console.log('\nPurging circuit project collections...');
    const delProjects = await db.collection('projects').deleteMany({});
    const delVersions = await db.collection('circuit_versions').deleteMany({});
    const delCircuits = await db.collection('circuits').deleteMany({});

    console.log('\nDeletion Results:');
    console.log(`- Deleted ${delProjects.deletedCount} documents from 'projects'`);
    console.log(`- Deleted ${delVersions.deletedCount} documents from 'circuit_versions'`);
    console.log(`- Deleted ${delCircuits.deletedCount} documents from 'circuits'`);
    console.log('\nAll Circuit projects and related data have been completely purged from the database.');
  } catch (err) {
    console.error('Error during database purge:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
