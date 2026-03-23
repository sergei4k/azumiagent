/**
 * amoCRM Integration
 * Creates leads and contacts in amoCRM from candidate applications
 */

const AMOCRM_SUBDOMAIN = process.env.AMOCRM_SUBDOMAIN!;
const AMOCRM_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!;
interface PipelineConfig {
  pipeline_id: number;
  status_id?: number;
}

const AMOCRM_PIPELINE_DEFAULT: PipelineConfig | undefined = (() => {
  try {
    return process.env.AMOCRM_PIPELINE_DEFAULT
      ? JSON.parse(process.env.AMOCRM_PIPELINE_DEFAULT)
      : undefined;
  } catch {
    console.warn('⚠️ AMOCRM_PIPELINE_DEFAULT is not valid JSON, ignoring');
    return undefined;
  }
})();

const AMOCRM_PIPELINE_MAP: Record<string, PipelineConfig> = (() => {
  try {
    return process.env.AMOCRM_PIPELINE_MAP
      ? JSON.parse(process.env.AMOCRM_PIPELINE_MAP)
      : {};
  } catch {
    console.warn('⚠️ AMOCRM_PIPELINE_MAP is not valid JSON, ignoring');
    return {};
  }
})();

/** Pipeline «Кандидаты» — WhatsApp bot only replies when lead is in STATUS_NEW_CANDIDATES_ID */
export const AMOCRM_PIPELINE_CANDIDATES_ID = Number(
  process.env.AMOCRM_PIPELINE_CANDIDATES_ID || 9081022,
);
/** Новые кандидаты — bot may chat */
export const AMOCRM_STATUS_NEW_CANDIDATES_ID = Number(
  process.env.AMOCRM_STATUS_NEW_CANDIDATES_ID || 73728086,
);
/** Квалифицирован — after full application (resume+video); bot stops on WhatsApp */
export const AMOCRM_STATUS_QUALIFIED_ID = Number(
  process.env.AMOCRM_STATUS_QUALIFIED_ID || 74242838,
);

function resolvePipeline(currentLocation?: string): PipelineConfig | undefined {
  if (!currentLocation) return AMOCRM_PIPELINE_DEFAULT;

  const loc = currentLocation.toLowerCase();
  for (const [keyword, config] of Object.entries(AMOCRM_PIPELINE_MAP)) {
    if (loc.includes(keyword.toLowerCase())) {
      console.log(`📍 Matched location "${currentLocation}" → pipeline ${config.pipeline_id}, status ${config.status_id ?? 'default'} (keyword: "${keyword}")`);
      return config;
    }
  }

  console.log(`📍 No pipeline match for "${currentLocation}", using default: ${AMOCRM_PIPELINE_DEFAULT?.pipeline_id ?? 'none'}`);
  return AMOCRM_PIPELINE_DEFAULT;
}
/** Override drive URL for file uploads. If unset, fetched from GET /account?with=drive_url. */
const AMOCRM_DRIVE_URL = process.env.AMOCRM_DRIVE_URL;

if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
  console.warn('⚠️ amoCRM credentials not configured. Set AMOCRM_SUBDOMAIN and AMOCRM_ACCESS_TOKEN in .env');
}

const baseUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4`;
let cachedDriveUrl: string | null = null;

/**
 * Convert a Google Drive download URL to a viewable link.
 * Input:  https://drive.google.com/uc?export=download&id=ABC123
 * Output: https://drive.google.com/file/d/ABC123/view
 */
function driveViewLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return `https://drive.google.com/file/d/${m[1]}/view`;
  if (url.includes('drive.google.com')) return url;
  return undefined;
}

interface CandidateData {
  applicationId: string;
  fullName: string;
  email?: string;
  phone: string;
  preferredContactMethod: string;
  nationality: string;
  currentLocation: string;

  availableFrom: string;
  preferredArrangement: string;
  willingToRelocate: boolean;
  preferredCountries?: string[];
  /** True when resume + intro video are present — lead moves to STATUS_QUALIFIED */
  submissionComplete?: boolean;
  resumeFile?: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
  };
  introVideoFile?: {
    fileId: string;
    fileName?: string;
    fileType?: string;
    fileUrl?: string;
    duration?: number;
  };
  additionalNotes?: string;
  /** Telegram: full notes on the lead. WhatsApp: upload files + set status only — chat is the record. */
  sourceChannel?: 'whatsapp' | 'telegram';
}

/**
 * Make a request to amoCRM API
 */
async function amoRequest(endpoint: string, method: string, body?: any, customHeaders?: Record<string, string>) {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    throw new Error('amoCRM credentials not configured');
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
    ...(customHeaders || {}),
  };

  // Only set Content-Type if not already set (for file uploads)
  if (!customHeaders?.['Content-Type'] && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: typeof body === 'string' ? body : (body ? JSON.stringify(body) : undefined),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`amoCRM API error: ${response.status} - ${error}`);
  }

  // amoCRM returns 204 with empty body when search has no results
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Get Kommo/amoCRM drive URL for file uploads.
 * Uses AMOCRM_DRIVE_URL if set, otherwise GET /account?with=drive_url.
 */
async function getDriveUrl(): Promise<string> {
  if (AMOCRM_DRIVE_URL) return AMOCRM_DRIVE_URL;
  if (cachedDriveUrl) return cachedDriveUrl;
  const acc = await amoRequest('/account?with=drive_url', 'GET');
  const url = (acc as any).drive_url;
  if (!url) throw new Error('amoCRM account has no drive_url. Set AMOCRM_DRIVE_URL or enable "Access to files" scope.');
  cachedDriveUrl = url.replace(/\/$/, '');
  return cachedDriveUrl as string;
}

/**
 * Kommo Files API: create upload session, upload file in chunks, return file UUID.
 * See https://developers.kommo.com/reference/create-session and upload-file.
 */
async function uploadFileToDrive(
  fileBytes: Buffer,
  fileName: string,
  driveUrl: string
): Promise<string> {
  const fileSize = fileBytes.length;
  const sessionRes = await fetch(`${driveUrl}/v1.0/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: fileName, size: fileSize }),
  });
  if (!sessionRes.ok) {
    const err = await sessionRes.text();
    throw new Error(`Create session failed: ${sessionRes.status} - ${err}`);
  }
  const session = (await sessionRes.json()) as {
    upload_url: string;
    max_part_size: number;
    session_id?: number;
  };
  const maxPart = session.max_part_size || 131072;
  let uploadUrl = session.upload_url;
  let offset = 0;
  let lastRes: { uuid?: string; next_url?: string } = {};
  while (offset < fileSize) {
    const end = Math.min(offset + maxPart, fileSize);
    const chunk = fileBytes.subarray(offset, end);
    const part = Uint8Array.from(chunk);
    const partRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(part.byteLength),
      },
      body: part,
    });
    if (!partRes.ok) {
      const err = await partRes.text();
      throw new Error(`Upload part failed: ${partRes.status} - ${err}`);
    }
    lastRes = (await partRes.json()) as { uuid?: string; next_url?: string };
    if (lastRes.next_url) {
      uploadUrl = lastRes.next_url;
      offset = end;
    } else {
      break;
    }
  }
  const uuid = lastRes.uuid;
  if (!uuid) throw new Error('Upload completed but no file UUID returned');
  return uuid;
}

/**
 * Attach files (by UUID) to a lead. Uses PUT /api/v4/leads/{id}/files.
 */
async function attachFilesToLead(leadId: number, fileUuids: string[]): Promise<void> {
  if (fileUuids.length === 0) return;
  const res = await fetch(`${baseUrl}/leads/${leadId}/files`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(fileUuids.map((uuid) => ({ file_uuid: uuid }))),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Attach files failed: ${res.status} - ${err}`);
  }
}

/**
 * Download file from URL, upload to Kommo drive, attach to lead.
 * Files are stored as real CRM attachments on Kommo/amoCRM file storage (not link strings).
 * Hosting: Kommo drive (default). Override via AMOCRM_DRIVE_URL.
 */
async function uploadFileToAmoCRM(
  fileUrl: string,
  fileName: string,
  entityType: 'leads' | 'contacts',
  entityId: number
): Promise<string> {
  console.log(`📥 Downloading file from ${fileUrl}...`);
  const fileResponse = await fetch(fileUrl, { redirect: 'follow' });
  if (!fileResponse.ok) {
    const body = await fileResponse.text().catch(() => '');
    throw new Error(`Failed to download file: HTTP ${fileResponse.status} ${body.substring(0, 200)}`);
  }
  const fileBuffer = await fileResponse.arrayBuffer();
  const fileBytes = Buffer.from(fileBuffer);
  if (fileBytes.length === 0) {
    throw new Error('Downloaded file is empty (0 bytes)');
  }
  console.log(`📥 Downloaded ${fileName}: ${(fileBytes.length / 1024).toFixed(1)} KB`);
  const driveUrl = await getDriveUrl();
  const uuid = await uploadFileToDrive(fileBytes, fileName, driveUrl);
  console.log(`📤 Uploaded to Kommo drive: ${fileName} (UUID: ${uuid})`);
  if (entityType === 'leads') {
    await attachFilesToLead(entityId, [uuid]);
    console.log(`✅ Attached to lead ${entityId}: ${fileName}`);
  }
  return uuid;
}

// ── CRM Candidate Search ──────────────────────────────────────────────

/** Cached pipeline status_id → human-readable status name. */
let pipelineStatusCache: Map<number, string> | null = null;

async function getPipelineStatusNames(): Promise<Map<number, string>> {
  if (pipelineStatusCache) return pipelineStatusCache;
  try {
    const res = await amoRequest('/leads/pipelines', 'GET');
    const map = new Map<number, string>();
    for (const pipeline of res?._embedded?.pipelines || []) {
      for (const status of pipeline?._embedded?.statuses || []) {
        map.set(status.id, status.name);
      }
    }
    pipelineStatusCache = map;
    return map;
  } catch (e) {
    console.error('Failed to fetch pipeline statuses:', e);
    return new Map();
  }
}

/** Collect every PHONE custom-field value (mobile/work can be multiple). */
function collectPhoneStringsFromContact(contact: {
  custom_fields_values?: Array<{
    field_code?: string;
    values?: Array<{ value?: string | number }>;
  }>;
}): string[] {
  const out: string[] = [];
  for (const field of contact.custom_fields_values || []) {
    if (field.field_code !== 'PHONE') continue;
    for (const v of field.values || []) {
      const raw = v?.value;
      if (raw == null || raw === '') continue;
      out.push(String(raw).trim());
    }
  }
  return out;
}

/**
 * Match WhatsApp E.164 digits to CRM-stored numbers (often national 10-digit US, extra +1, etc.).
 */
function phoneDigitsMatch(searchDigits: string, contactDigits: string): boolean {
  if (!searchDigits || !contactDigits) return false;
  if (searchDigits === contactDigits) return true;
  if (searchDigits.endsWith(contactDigits) || contactDigits.endsWith(searchDigits)) return true;
  const stripLeadingUS1 = (d: string) =>
    d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  const a = stripLeadingUS1(searchDigits);
  const b = stripLeadingUS1(contactDigits);
  if (a === b) return true;
  if (a.length >= 7 && b.length >= 7 && (a.endsWith(b) || b.endsWith(a))) return true;
  if (searchDigits.length >= 7 && contactDigits.length >= 7) {
    if (searchDigits.slice(-7) === contactDigits.slice(-7)) return true;
  }
  return false;
}

/**
 * Search amoCRM for an existing candidate by phone, email, or name.
 * Returns contact info and their linked leads with real pipeline statuses.
 */
export async function searchCandidateInCRM(params: {
  phone?: string;
  name?: string;
  email?: string;
}): Promise<{
  found: boolean;
  contact?: {
    id: number;
    name: string;
    phone?: string;
    email?: string;
  };
  leads: Array<{
    id: number;
    name: string;
    status: string;
    createdAt: string;
    url: string;
  }>;
}> {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    console.warn('amoCRM not configured, cannot search candidates');
    return { found: false, leads: [] };
  }

  // Search in priority order: phone → email → name
  const queries = [params.phone, params.email, params.name].filter(Boolean) as string[];

  for (const query of queries) {
    try {
      const contactRes = await amoRequest(
        `/contacts?query=${encodeURIComponent(query)}&with=leads`,
        'GET',
      );
      const contacts = contactRes?._embedded?.contacts;
      if (!contacts?.length) continue;

      // Find a contact whose phone actually matches (digits-only comparison)
      const normalize = (s: string) => s.replace(/\D/g, '');
      const searchDigits = query ? normalize(query) : '';

      let contact = null;
      let contactPhone: string | undefined;
      let contactEmail: string | undefined;

      for (const c of contacts) {
        let cPhone: string | undefined;
        let cEmail: string | undefined;
        for (const field of c.custom_fields_values || []) {
          if (field.field_code === 'PHONE') {
            const first = field.values?.[0]?.value;
            if (first != null && first !== '') cPhone = String(first).trim();
          }
          if (field.field_code === 'EMAIL') cEmail = field.values?.[0]?.value;
        }

        const phoneStrings = collectPhoneStringsFromContact(c);
        if (params.phone && searchDigits.length >= 7 && phoneStrings.length > 0) {
          let matched = false;
          for (const ps of phoneStrings) {
            const cDigits = normalize(ps);
            if (phoneDigitsMatch(searchDigits, cDigits)) {
              contact = c;
              contactPhone = ps;
              contactEmail = cEmail;
              matched = true;
              break;
            }
          }
          if (matched) break;
        } else if (params.email && cEmail && cEmail.toLowerCase() === query.toLowerCase()) {
          contact = c;
          contactPhone = cPhone;
          contactEmail = cEmail;
          break;
        } else if (params.name) {
          contact = c;
          contactPhone = cPhone;
          contactEmail = cEmail;
          break;
        }
      }

      // amoCRM relevance: one hit for a phone query but empty/malformed PHONE fields — still gate on this contact
      if (
        !contact &&
        contacts.length === 1 &&
        params.phone &&
        searchDigits.length >= 7
      ) {
        const only = contacts[0];
        const phoneStrings = collectPhoneStringsFromContact(only);
        if (phoneStrings.length === 0) {
          console.warn(
            `🔍 amoCRM: query "${query}" returned 1 contact (id=${only.id}) with no PHONE field values — using amo search relevance match`,
          );
          contact = only;
          let cEmail: string | undefined;
          for (const field of only.custom_fields_values || []) {
            if (field.field_code === 'EMAIL') cEmail = field.values?.[0]?.value;
          }
          contactPhone = undefined;
          contactEmail = cEmail;
        }
      }

      if (!contact) {
        console.log(`🔍 amoCRM: query "${query}" returned ${contacts.length} result(s) but none matched exactly`);
        continue;
      }

      // Get linked lead IDs from embedded data
      const embeddedLeads: Array<{ id: number }> = contact._embedded?.leads || [];

      // Fetch full details for each lead (limit to 5 most recent)
      const statusMap = await getPipelineStatusNames();
      const leads: Array<{
        id: number;
        name: string;
        status: string;
        status_id: number;
        pipeline_id: number;
        createdAt: string;
        url: string;
      }> = [];

      for (const ref of embeddedLeads.slice(0, 5)) {
        try {
          const lead = await amoRequest(`/leads/${ref.id}`, 'GET');
          leads.push({
            id: lead.id,
            name: lead.name || `Lead #${lead.id}`,
            status: statusMap.get(lead.status_id) || `Unknown status (${lead.status_id})`,
            status_id: lead.status_id,
            pipeline_id: lead.pipeline_id,
            createdAt: lead.created_at
              ? new Date(lead.created_at * 1000).toISOString()
              : 'unknown',
            url: `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${lead.id}`,
          });
        } catch (e) {
          console.warn(`Could not fetch lead ${ref.id}:`, e);
        }
      }

      // Sort leads by creation date, most recent first
      leads.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      console.log(`🔍 amoCRM: found contact "${contact.name}" (ID: ${contact.id}) with ${leads.length} lead(s)`);
      return {
        found: true,
        contact: {
          id: contact.id,
          name: contact.name,
          phone: contactPhone,
          email: contactEmail,
        },
        leads,
      };
    } catch (error) {
      console.error(`amoCRM search failed for "${query}":`, error);
    }
  }

  console.log(`🔍 amoCRM: no candidate found for: ${queries.join(', ')}`);
  return { found: false, leads: [] };
}

/**
 * Single CRM fetch for WhatsApp: bot gate + model preface.
 * Bot only replies when there is no lead in pipeline AMOCRM_PIPELINE_CANDIDATES_ID,
 * or the latest lead there is in AMOCRM_STATUS_NEW_CANDIDATES_ID (Новые кандидаты).
 * After full submit, lead moves to AMOCRM_STATUS_QUALIFIED_ID — bot stops (no reply).
 */
export async function getWhatsappCrmContextForBot(phoneDigits: string | null): Promise<{
  allowBot: boolean;
  preface: string;
}> {
  if (!phoneDigits || phoneDigits.replace(/\D/g, '').length < 7) {
    return {
      allowBot: true,
      preface:
        '[WA·CRM] No phone number resolved for this chat (e.g. @lid only). CRM search skipped — do not treat JID as phone.',
    };
  }
  const digits = phoneDigits.replace(/\D/g, '');
  const phoneQuery = phoneDigits.trim().startsWith('+') ? phoneDigits.trim() : `+${digits}`;
  try {
    const r = await searchCandidateInCRM({ phone: phoneQuery });

    if (r.found && r.leads?.length) {
      const inCandidatesPipeline = r.leads.filter((l) => l.pipeline_id === AMOCRM_PIPELINE_CANDIDATES_ID);
      if (inCandidatesPipeline.length > 0) {
        inCandidatesPipeline.sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        const latest = inCandidatesPipeline[0];
        if (latest.status_id !== AMOCRM_STATUS_NEW_CANDIDATES_ID) {
          console.log(
            `[WA] Bot gate: block — lead ${latest.id} pipeline ${latest.pipeline_id} status_id=${latest.status_id} (only ${AMOCRM_STATUS_NEW_CANDIDATES_ID} = bot active)`,
          );
          return { allowBot: false, preface: '' };
        }
      }
    }

    if (!r.found || !r.contact) {
      return { allowBot: true, preface: '[WA·CRM] no contact matched this WhatsApp number.' };
    }

    const pipelineLeads = r.leads.filter((l) => l.pipeline_id === AMOCRM_PIPELINE_CANDIDATES_ID);
    const sorted = (pipelineLeads.length ? pipelineLeads : [...r.leads]).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const latestLead = sorted[0];
    const applicationId = latestLead ? `AZM-${latestLead.id}` : `CRM-${r.contact.id}`;
    console.log(
      `[WA] CRM pre-search by phone: matched "${r.contact.name}" → ${applicationId} (${r.leads.length} lead(s))`,
    );
    const preface =
      `[WA·CRM] contact "${r.contact.name}", applicationId ${applicationId}. ` +
      `Server already matched this WhatsApp number — do NOT call lookup-candidate on WhatsApp. ` +
      `Use applicationId only for attach-files or add-note. Never disclose status or pipeline to the candidate.`;
    return { allowBot: true, preface };
  } catch (e) {
    console.warn('[WA] CRM context failed:', e);
    return { allowBot: true, preface: '[WA·CRM] search failed or unavailable.' };
  }
}

/**
 * Search for existing contact by phone or email
 */
async function findExistingContact(phone: string, email?: string): Promise<number | null> {
  try {
    if (email) {
      // Search by email
      const emailResponse = await amoRequest(
        `/contacts?query=${encodeURIComponent(email)}`,
        'GET'
      );
      if (emailResponse._embedded?.contacts?.[0]?.id) {
        return emailResponse._embedded.contacts[0].id;
      }
    }

    // Search by phone
    const phoneResponse = await amoRequest(
      `/contacts?query=${encodeURIComponent(phone)}`,
      'GET'
    );
    if (phoneResponse._embedded?.contacts?.[0]?.id) {
      return phoneResponse._embedded.contacts[0].id;
    }

    return null;
  } catch (error) {
    console.error('Error searching for contact:', error);
    return null;
  }
}

/**
 * Create a candidate lead and contact in amoCRM
 */
export async function createCandidateLead(data: CandidateData): Promise<{
  contactId: number;
  leadId: number;
  leadUrl: string;
}> {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    throw new Error('amoCRM not configured. Set AMOCRM_SUBDOMAIN and AMOCRM_ACCESS_TOKEN');
  }

  // Check if contact already exists
  const existingContactId = await findExistingContact(data.phone, data.email);

  let contactId: number;

  if (existingContactId) {
    // Update existing contact
    console.log(`📝 Updating existing contact ${existingContactId} in amoCRM`);
    contactId = existingContactId;
  } else {
    // Create new contact
    const contactResponse = await amoRequest('/contacts', 'POST', [
      {
        name: data.fullName,
        custom_fields_values: [
          {
            field_code: 'PHONE',
            values: [{ value: data.phone, enum_code: 'WORK' }],
          },
          ...(data.email ? [{
            field_code: 'EMAIL',
            values: [{ value: data.email, enum_code: 'WORK' }],
          }] : []),
        ],
      },
    ]);

    contactId = contactResponse._embedded.contacts[0].id;
    console.log(`✅ Created new contact ${contactId} in amoCRM`);
  }

  // Build lead name
  const leadName = `Кандидат: ${data.fullName}`;

  const skipCrmNotes = data.sourceChannel === 'whatsapp';

  // Create comprehensive note with all candidate details (Telegram; WhatsApp skips — chat is the record)
  const noteText = `📝 Заявка через чат-бот Azumi

🆔 ID заявки: ${data.applicationId}
📅 Дата: ${new Date().toLocaleString('ru-RU')}

👤 Личная информация:
• Имя: ${data.fullName}
• Национальность: ${data.nationality}
• Местоположение: ${data.currentLocation}
• Телефон: ${data.phone}

🛂 Виза:
• Есть действующая виза: ${(data as any).hasValidVisa ? 'Да' : 'Нет'}
${(data as any).visaDetails ? `• Детали визы: ${(data as any).visaDetails}` : ''}

📋 Документы:
${data.resumeFile ? `• Резюме: ${data.resumeFile.fileName || 'приложено'}${driveViewLink(data.resumeFile?.fileUrl) ? `\n  Google Drive: ${driveViewLink(data.resumeFile.fileUrl)}` : ''}` : '• Резюме: не предоставлено'}
${data.introVideoFile ? `• Видео: ${data.introVideoFile.fileName || 'приложено'} (${data.introVideoFile.duration ? Math.floor(data.introVideoFile.duration / 60) + ':' + (data.introVideoFile.duration % 60).toString().padStart(2, '0') : 'длительность неизвестна'})${driveViewLink(data.introVideoFile?.fileUrl) ? `\n  Google Drive: ${driveViewLink(data.introVideoFile.fileUrl)}` : ''}` : '• Видео: не предоставлено'}

📅 Доступность:
• Готов начать: ${data.availableFrom}
• Предпочтение: ${data.preferredArrangement}
• Готов к переезду: ${data.willingToRelocate ? 'Да' : 'Нет'}
${data.preferredCountries?.length ? `• Предпочтительные страны: ${data.preferredCountries.join(', ')}` : ''}


${data.additionalNotes ? `\n📝 Дополнительная информация:\n${data.additionalNotes}` : ''}



🤖 Источник: Telegram чат-бот`;

  // Create lead linked to contact
  const leadData: any = {
    name: leadName,
    _embedded: {
      contacts: [{ id: contactId }],
    },
  };

  // Кандидаты pipeline: new → STATUS_NEW_CANDIDATES, full submission (resume+video) → STATUS_QUALIFIED
  const statusForLead = data.submissionComplete
    ? AMOCRM_STATUS_QUALIFIED_ID
    : AMOCRM_STATUS_NEW_CANDIDATES_ID;
  leadData.pipeline_id = AMOCRM_PIPELINE_CANDIDATES_ID;
  leadData.status_id = statusForLead;
  console.log(
    `📍 Lead pipeline ${AMOCRM_PIPELINE_CANDIDATES_ID}, status ${statusForLead} (${data.submissionComplete ? 'qualified / complete' : 'new candidates'})`,
  );

  const leadResponse = await amoRequest('/leads', 'POST', [leadData]);

  const leadId = leadResponse._embedded.leads[0].id;

  // Add note with full details (skip on WhatsApp — messages are already in the chat)
  if (!skipCrmNotes) {
    await amoRequest('/leads/notes', 'POST', [
      {
        entity_id: leadId,
        note_type: 'common',
        params: {
          text: noteText,
        },
      },
    ]);
  }

  // Upload files as attachments to the lead
  if (data.resumeFile) {
    if (!data.resumeFile.fileUrl) {
      console.warn('📎 Skipping resume upload to amoCRM: no fileUrl (fileId=%s)', data.resumeFile.fileId);
    } else {
      try {
        const fileName = data.resumeFile.fileName || `resume_${data.fullName.replace(/\s+/g, '_')}.pdf`;
        console.log('📤 Uploading resume to amoCRM: %s', fileName);
        await uploadFileToAmoCRM(data.resumeFile.fileUrl, fileName, 'leads', leadId);
        const driveLink = driveViewLink(data.resumeFile.fileUrl);
        if (!skipCrmNotes) {
          await amoRequest('/leads/notes', 'POST', [
            {
              entity_id: leadId,
              note_type: 'common',
              params: {
                text: `📄 Резюме кандидата приложено: ${fileName}${driveLink ? `\nGoogle Drive: ${driveLink}` : ''}`,
              },
            },
          ]);
        }
      } catch (error) {
        console.error('Failed to upload resume:', error);
        const link = driveViewLink(data.resumeFile.fileUrl);
        if (!skipCrmNotes) {
          await amoRequest('/leads/notes', 'POST', [
            {
              entity_id: leadId,
              note_type: 'common',
              params: {
                text: link
                  ? `📄 Резюме кандидата (ссылка):\n${link}`
                  : `📄 Резюме кандидата: файл получен, но загрузка не удалась. Файл доступен в Google Drive папке.`,
              },
            },
          ]);
        }
      }
    }
  }

  if (data.introVideoFile) {
    if (!data.introVideoFile.fileUrl) {
      console.warn('📎 Skipping intro video upload to amoCRM: no fileUrl (fileId=%s)', data.introVideoFile.fileId);
    } else {
      try {
        const fileName = data.introVideoFile.fileName || `intro_video_${data.fullName.replace(/\s+/g, '_')}.mp4`;
        console.log('📤 Uploading intro video to amoCRM: %s', fileName);
        await uploadFileToAmoCRM(data.introVideoFile.fileUrl, fileName, 'leads', leadId);
        const durationInfo = data.introVideoFile.duration
          ? ` (${Math.floor(data.introVideoFile.duration / 60)}:${(data.introVideoFile.duration % 60).toString().padStart(2, '0')})`
          : '';
        const driveLink = driveViewLink(data.introVideoFile.fileUrl);
        if (!skipCrmNotes) {
          await amoRequest('/leads/notes', 'POST', [
            {
              entity_id: leadId,
              note_type: 'common',
              params: {
                text: `🎥 Видео-представление кандидата приложено: ${fileName}${durationInfo}${driveLink ? `\nGoogle Drive: ${driveLink}` : ''}`,
              },
            },
          ]);
        }
      } catch (error) {
        console.error('Failed to upload video:', error);
        const link = driveViewLink(data.introVideoFile.fileUrl);
        if (!skipCrmNotes) {
          await amoRequest('/leads/notes', 'POST', [
            {
              entity_id: leadId,
              note_type: 'common',
              params: {
                text: link
                  ? `🎥 Видео-представление кандидата (ссылка):\n${link}`
                  : `🎥 Видео-представление: файл получен, но загрузка не удалась. Файл доступен в Google Drive папке.`,
              },
            },
          ]);
        }
      }
    }
  }

  return {
    contactId,
    leadId,
    leadUrl: `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${leadId}`,
  };
}

/** File entry for attaching to existing leads */
export type AttachFileEntry = {
  fileId: string;
  fileName?: string;
  fileType?: string;
  fileUrl?: string;
  duration?: number;
};

/**
 * Add a text note to an existing lead.
 */
export async function addNoteToLead(leadId: number, noteText: string): Promise<void> {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    throw new Error('amoCRM not configured');
  }
  await amoRequest('/leads/notes', 'POST', [
    {
      entity_id: leadId,
      note_type: 'common',
      params: { text: noteText },
    },
  ]);
}

/**
 * Update lead status within the candidates pipeline (e.g. move to «qualified» when resume+video are on the lead).
 */
export async function updateLeadStatusInCandidatesPipeline(leadId: number, statusId: number): Promise<void> {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    throw new Error('amoCRM not configured');
  }
  await amoRequest('/leads', 'PATCH', [
    {
      id: leadId,
      pipeline_id: AMOCRM_PIPELINE_CANDIDATES_ID,
      status_id: statusId,
    },
  ]);
}

/**
 * Attach new files (resume, intro video) to an existing lead and add a note.
 * Use when a returning candidate sends updated documents or new files.
 * WhatsApp: no CRM text notes (chat is the record); when both resume+video URLs are present, moves lead to qualified status.
 */
export async function attachFilesToExistingLead(
  leadId: number,
  files: {
    resumeFile?: AttachFileEntry;
    introVideoFile?: AttachFileEntry;
  },
  candidateName: string,
  noteText?: string,
  options?: { sourceChannel?: 'whatsapp' | 'telegram' },
): Promise<{ attached: string[] }> {
  if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
    throw new Error('amoCRM not configured');
  }

  const skipCrmNotes = options?.sourceChannel === 'whatsapp';
  const attached: string[] = [];

  const safeName = candidateName.replace(/\s+/g, '_').slice(0, 50);

  async function uploadOne(
    file: AttachFileEntry | undefined,
    label: string,
    defaultFileName: string,
  ): Promise<void> {
    if (!file?.fileUrl) return;
    const fileName = file.fileName || defaultFileName;
    try {
      await uploadFileToAmoCRM(file.fileUrl, fileName, 'leads', leadId);
      attached.push(fileName);
      if (!skipCrmNotes) {
        const link = driveViewLink(file.fileUrl);
        await addNoteToLead(
          leadId,
          `${label}: ${fileName}${link ? `\nGoogle Drive: ${link}` : ''}`,
        );
      }
    } catch (err) {
      console.error(`Failed to upload ${label}:`, err);
      if (!skipCrmNotes) {
        const link = file.fileUrl;
        await addNoteToLead(leadId, `${label} (ссылка):\n${link}`);
      }
      attached.push(fileName);
    }
  }

  if (files.resumeFile?.fileUrl) {
    await uploadOne(
      files.resumeFile,
      '📄 Обновлённое резюме',
      `resume_update_${safeName}.pdf`,
    );
  }

  if (files.introVideoFile?.fileUrl) {
    const dur = files.introVideoFile.duration
      ? ` (${Math.floor(files.introVideoFile.duration / 60)}:${(files.introVideoFile.duration % 60).toString().padStart(2, '0')})`
      : '';
    await uploadOne(
      files.introVideoFile,
      `🎥 Видео-представление${dur}`,
      `intro_video_${safeName}.mp4`,
    );
  }

  if (!skipCrmNotes) {
    const header = `📝 Обновление заявки кандидата\n📅 ${new Date().toLocaleString('ru-RU')}\n`;
    const body = noteText ? `\nНовая информация от кандидата:\n${noteText}\n` : '';
    const filesList =
      attached.length > 0
        ? `\nПрикреплённые файлы: ${attached.join(', ')}`
        : '';
    await addNoteToLead(leadId, `${header}${body}${filesList}\n🤖 Источник: Telegram чат-бот`);
  } else if (files.resumeFile?.fileUrl && files.introVideoFile?.fileUrl) {
    try {
      await updateLeadStatusInCandidatesPipeline(leadId, AMOCRM_STATUS_QUALIFIED_ID);
      console.log(
        `[WA] Lead ${leadId} → status ${AMOCRM_STATUS_QUALIFIED_ID} (resume+video on lead; no duplicate CRM notes)`,
      );
    } catch (e) {
      console.error('[WA] Failed to move lead to qualified after attach:', e);
    }
  }

  return { attached };
}

/**
 * Helper to fetch all pipelines and their statuses
 * Use this to find pipeline_id and status_id
 */
export async function getPipelines() {
  try {
    const pipelines = await amoRequest('/leads/pipelines', 'GET');
    
    console.log('📊 Available Pipelines:');
    pipelines._embedded.pipelines.forEach((pipeline: any) => {
      console.log(`\n  Pipeline ID: ${pipeline.id}`);
      console.log(`  Name: ${pipeline.name}`);
      console.log(`  Statuses:`);
      pipeline._embedded.statuses.forEach((status: any) => {
        console.log(`    - Status ID: ${status.id} | Name: ${status.name}`);
      });
    });


    return pipelines;
  } catch (error) {
    console.error('Error fetching pipelines:', error);
    throw error;
  }
}

/** Print amoCRM custom_fields API response as one line per field / enum (no JSON dump). */
function printCustomFieldsList(label: string, res: any): void {
  const fields = res?._embedded?.custom_fields ?? [];
  console.log(`\n── ${label} (${fields.length} fields) ──`);
  for (const f of fields) {
    const code = f.code ? ` | code: ${f.code}` : '';
    console.log(`  Field ID: ${f.id} | ${f.name} | type: ${f.type}${code}`);

    const enums = f.enums;
    if (Array.isArray(enums) && enums.length > 0) {
      for (const e of enums) {
        console.log(`    → enum ID: ${e.id} | ${e.value ?? e.name ?? '?'}`);
      }
    }
  }
}

/**
 * Helper to fetch custom field IDs (run once to see what fields are available)
 */
export async function getCustomFields() {
  try {
    const leadFields = await amoRequest('/leads/custom_fields', 'GET');
    const contactFields = await amoRequest('/contacts/custom_fields', 'GET');

    printCustomFieldsList('LEAD custom fields', leadFields);
    printCustomFieldsList('CONTACT custom fields', contactFields);

    return { leadFields, contactFields };
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    throw error;
  }
}
