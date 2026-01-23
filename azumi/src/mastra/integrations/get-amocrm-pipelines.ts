/**
 * Helper script to fetch amoCRM pipelines and statuses
 * Run with: npx tsx src/mastra/integrations/get-amocrm-pipelines.ts
 */

import 'dotenv/config';
import { getPipelines } from './amocrm';

async function main() {
  console.log('🔍 Fetching amoCRM pipelines...\n');
  
  try {
    await getPipelines();
    console.log('\n✅ Done! Copy the Pipeline ID and Status ID you want to use.');
    console.log('\nThen add to your .env file:');
    console.log('AMOCRM_PIPELINE_ID=your_pipeline_id');
    console.log('AMOCRM_STATUS_ID=your_status_id');
  } catch (error) {
    console.error('\n❌ Error:', error);
    console.log('\nMake sure you have set:');
    console.log('- AMOCRM_SUBDOMAIN');
    console.log('- AMOCRM_ACCESS_TOKEN');
    process.exit(1);
  }
}

main();
