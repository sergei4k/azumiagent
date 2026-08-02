import { readFile, writeFile } from 'node:fs/promises';

const [sourcePath, outputPath] = process.argv.slice(2);

if (!sourcePath || !outputPath) {
  throw new Error('Usage: node scripts/sanitize-workflow.mjs <production-export.json> <workflow.template.json>');
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const workflow = Array.isArray(source) ? source[0] : source;

workflow.name = 'ai-recruitment-automation-template';
workflow.active = false;
delete workflow.id;
delete workflow.versionId;
delete workflow.meta;

function replaceText(value) {
  if (typeof value === 'string') {
    return value
      .replace(/https:\/\/[a-z0-9-]+\.supabase\.co/gi, 'https://YOUR_SUPABASE_PROJECT.supabase.co')
      .replace(/https?:\/\/t\.me\/[\w-]+/gi, 'https://example.com/vacancies')
      .replace(/https?:\/\/www\.facebook\.com\/groups\/[\w-]+/gi, 'https://example.com/vacancies')
      .replace(/Ты — AI-агент рекрутингового агентства [^.\n]+/g, 'Ты — AI-агент рекрутингового агентства Example Recruitment Agency')
      .replace(/\b\d{7,}\b/g, 'YOUR_NUMERIC_ID');
  }
  if (Array.isArray(value)) return value.map(replaceText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceText(item)]));
  }
  return value;
}

function redactResourceLocators(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redactResourceLocators(item));
  if (!value || typeof value !== 'object') return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([childKey, item]) => [childKey, redactResourceLocators(item, childKey)]),
  );

  if ((key === 'driveId' || key === 'folderId') && typeof result.value === 'string' && !result.value.startsWith('=')) {
    const label = key === 'driveId' ? 'YOUR_GOOGLE_DRIVE_ID' : 'YOUR_GOOGLE_DRIVE_FOLDER_ID';
    result.value = label;
    if ('cachedResultName' in result) result.cachedResultName = label;
  }

  if (result.name?.toLowerCase() === 'apikey' && 'value' in result) {
    result.value = 'YOUR_SUPABASE_SERVICE_ROLE_KEY';
  }

  return result;
}

for (const node of workflow.nodes ?? []) {
  delete node.credentials;
  node.parameters = redactResourceLocators(node.parameters);

  if (node.type === 'n8n-nodes-base.webhook') {
    node.parameters.path = 'YOUR_WEBHOOK_PATH';
    node.webhookId = 'YOUR_WEBHOOK_ID';
  }

  if (node.name === 'Constants') {
    node.parameters.jsonOutput = JSON.stringify({
      ALLOWED_PIPELINES: [111111, 222222],
      ALLOWED_STATUSES_NEW: [333333, 444444],
      QUALIFIED_STATUS_ID: 555555,
      QUALIFIED_STATUS_BY_PIPELINE: { '111111': 555555, '222222': 666666 },
      BOT_OFF_FIELD_ID: 777777,
      CLIENT_GOOGLE_LINK_FIELD_ID: 888888,
      ACCOUNT_ID_AMOCRM: 999999,
      VACANCY_LINKS_RU: 'https://example.com/vacancies-ru',
      VACANCY_LINKS_EN: 'https://example.com/vacancies-en',
      LLM_PROVIDER: 'YOUR_LLM_PROVIDER',
      COUNTRY_BY_PIPELINE: { '111111': 'KZ', '222222': 'RU' },
    }, null, 2);
  }
}

const sanitized = replaceText(workflow);
await writeFile(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`);
