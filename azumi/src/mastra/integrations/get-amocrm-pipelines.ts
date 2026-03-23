/**
 * Helper script to fetch amoCRM pipelines and statuses
 * Run with: npx tsx src/mastra/integrations/get-amocrm-pipelines.ts
 */

import 'dotenv/config';
import { getCustomFields, getPipelines } from './amocrm';

async function main() {
  console.log('🔍 Fetching amoCRM pipelines and statuses...\n');

  try {
    await getPipelines();

    console.log('\n\n📋 Fetching Lead + Contact custom field definitions (IDs, enums)...\n');
    await getCustomFields();

    console.log('\n✅ Done! Use Pipeline ID + Status ID for lead stages; custom field IDs from the JSON above.');
    console.log('\nOptional .env:');
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
