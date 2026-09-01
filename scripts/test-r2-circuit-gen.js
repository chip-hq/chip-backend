/**
 * Test Circuit Generation using pure Cloudflare R2 on-demand symbols
 */
import { generateProjectCircuit } from '../circuit/circuit-runner.js';
import { tmpdir } from 'os';
import { join } from 'path';

async function testR2Generation() {
  console.log('Testing Circuit Generation with Cloudflare R2 on-demand symbols...');
  console.log('KICAD_SYMBOL_DIR env:', process.env.KICAD_SYMBOL_DIR || '(Not set - using Cloudflare R2)');

  const outDir = join(tmpdir(), 'chip-r2-test-circuit');
  const result = await generateProjectCircuit({
    projectId: 'test-r2-smoke',
    outDir,
    version: 1,
    resistorValue: '330',
  });

  console.log('\n--- Generation Result ---');
  console.log('Success:', result.success);
  console.log('Components generated:', result.components?.length || 0);
  console.log('Connections generated:', result.connections?.length || 0);
  if (result.error) console.log('Error:', result.error);
  if (result.components) console.log('Components:', result.components.map(c => `${c.ref} (${c.name})`));
}

testR2Generation();
