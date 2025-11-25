#!/usr/bin/env node

import { setupCORS } from './setup-cors.js';

console.log('╔══════════════════════════════════════════╗');
console.log('║   B2 Whisper Transcriber - Quick Setup  ║');
console.log('╚══════════════════════════════════════════╝\n');

console.log('This will configure your B2 bucket for browser uploads.\n');

setupCORS().then(() => {
  console.log('\n✅ All done! Start the server with: npm start\n');
}).catch((error) => {
  console.error('\n❌ Setup failed. Please check the error above.\n');
  process.exit(1);
});
