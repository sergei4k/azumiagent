/**
 * amoCRM Integration
 * Creates leads and contacts in amoCRM from candidate applications
 */

const AMOCRM_SUBDOMAIN = process.env.AMOCRM_SUBDOMAIN!;
const AMOCRM_ACCESS_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!;
const AMOCRM_PIPELINE_ID = process.env.AMOCRM_KZPIPELINE ? parseInt(process.env.AMOCRM_KZPIPELINE) : undefined;
const AMOCRM_STATUS_ID = process.env.AMOCRM_STATUS_ID ? parseInt(process.env.AMOCRM_STATUS_ID) : undefined;
/** Override drive URL for file uploads. If unset, fetched from GET /account?with=drive_url. */
const AMOCRM_DRIVE_URL = process.env.AMOCRM_DRIVE_URL;

if (!AMOCRM_SUBDOMAIN || !AMOCRM_ACCESS_TOKEN) {
  console.warn('⚠️ amoCRM credentials not configured. Set AMOCRM_SUBDOMAIN and AMOCRM_ACCESS_TOKEN in .env');
}

const baseUrl = `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/api/v4`;
let cachedDriveUrl: string | null = null;

interface CandidateData {
  applicationId: string;
  fullName: string;
  email?: string;
  phone: string;
  preferredContactMethod: string;
  nationality: string;
  currentLocation: string;
  dateOfBirth?: string;
  languages: { language: string; fluency: string }[];
  ageGroupsWorkedWith: string[];
  previousPositions: string;
  educationSummary: string;
  specializations?: string[];
  availableFrom: string;
  preferredArrangement: string;
  willingToRelocate: boolean;
  preferredCountries?: string[];
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
  hasValidPassport: boolean;
  additionalNotes?: string;
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

  return response.json();
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
    const partRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AMOCRM_ACCESS_TOKEN}`,
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(chunk),
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
  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(`Failed to download file: ${fileResponse.status}`);
  }
  const fileBuffer = await fileResponse.arrayBuffer();
  const fileBytes = Buffer.from(fileBuffer);
  const driveUrl = await getDriveUrl();
  const uuid = await uploadFileToDrive(fileBytes, fileName, driveUrl);
  console.log(`📤 Uploaded to Kommo drive: ${fileName} (UUID: ${uuid})`);
  if (entityType === 'leads') {
    await attachFilesToLead(entityId, [uuid]);
    console.log(`✅ Attached to lead ${entityId}: ${fileName}`);
  }
  return uuid;
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

  // Create comprehensive note with all candidate details
  const noteText = `📝 Заявка через чат-бот Azumi

🆔 ID заявки: ${data.applicationId}
📅 Дата: ${new Date().toLocaleString('ru-RU')}

👤 Личная информация:
• Имя: ${data.fullName}
• Национальность: ${data.nationality}
• Местоположение: ${data.currentLocation}
• Телефон: ${data.phone}


${data.dateOfBirth ? `• Дата рождения: ${data.dateOfBirth}` : ''}

🌍 Языки:
${data.languages.map(l => `• ${l.language} - ${l.fluency}`).join('\n')}

💼 Опыт:
• Возрастные группы: ${data.ageGroupsWorkedWith.join(', ')}
• Предыдущие позиции: ${data.previousPositions}

🎓 Образование:
${data.educationSummary}

${data.specializations?.length ? `✨ Специализации:\n${data.specializations.map(s => `• ${s}`).join('\n')}` : ''}

📋 Документы:
• Паспорт: ${data.hasValidPassport ? 'Да' : 'Нет'}
${data.resumeFile ? `• Резюме: ${data.resumeFile.fileName || 'приложено'}` : '• Резюме: не предоставлено'}
${data.introVideoFile ? `• Видео: ${data.introVideoFile.fileName || 'приложено'} (${data.introVideoFile.duration ? Math.floor(data.introVideoFile.duration / 60) + ':' + (data.introVideoFile.duration % 60).toString().padStart(2, '0') : 'длительность неизвестна'})` : '• Видео: не предоставлено'}

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

  // Set pipeline if configured
  if (AMOCRM_PIPELINE_ID) {
    leadData.pipeline_id = AMOCRM_PIPELINE_ID;
  }

  // Set status if configured (status_id is specific to the pipeline)
  if (AMOCRM_STATUS_ID) {
    leadData.status_id = AMOCRM_STATUS_ID;
  }

  const leadResponse = await amoRequest('/leads', 'POST', [leadData]);

  const leadId = leadResponse._embedded.leads[0].id;

  // Add note with full details
  await amoRequest('/leads/notes', 'POST', [
    {
      entity_id: leadId,
      note_type: 'common',
      params: {
        text: noteText,
      },
    },
  ]);

  // Upload files as attachments to the lead
  if (data.resumeFile) {
    if (!data.resumeFile.fileUrl) {
      console.warn('📎 Skipping resume upload to amoCRM: no fileUrl (fileId=%s)', data.resumeFile.fileId);
    } else {
      try {
        const fileName = data.resumeFile.fileName || `resume_${data.fullName.replace(/\s+/g, '_')}.pdf`;
        console.log('📤 Uploading resume to amoCRM: %s', fileName);
        await uploadFileToAmoCRM(data.resumeFile.fileUrl, fileName, 'leads', leadId);
      
      // Also add a note with the file reference
      await amoRequest('/leads/notes', 'POST', [
        {
          entity_id: leadId,
          note_type: 'common',
          params: {
            text: `📄 Резюме кандидата приложено: ${fileName}`,
          },
        },
      ]);
    } catch (error) {
      console.error('Failed to upload resume, adding URL as note instead:', error);
      // Fallback: add URL as note if upload fails
      await amoRequest('/leads/notes', 'POST', [
        {
          entity_id: leadId,
          note_type: 'common',
          params: {
            text: `📄 Резюме кандидата (ссылка):\n${data.resumeFile.fileUrl}`,
          },
        },
      ]);
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
      
      // Also add a note with the file reference
      const durationInfo = data.introVideoFile.duration
        ? ` (${Math.floor(data.introVideoFile.duration / 60)}:${(data.introVideoFile.duration % 60).toString().padStart(2, '0')})`
        : '';
      await amoRequest('/leads/notes', 'POST', [
        {
          entity_id: leadId,
          note_type: 'common',
          params: {
            text: `🎥 Видео-представление кандидата приложено: ${fileName}${durationInfo}`,
          },
        },
      ]);
    } catch (error) {
      console.error('Failed to upload video, adding URL as note instead:', error);
      // Fallback: add URL as note if upload fails
      await amoRequest('/leads/notes', 'POST', [
        {
          entity_id: leadId,
          note_type: 'common',
          params: {
            text: `🎥 Видео-представление кандидата (ссылка):\n${data.introVideoFile.fileUrl}`,
          },
        },
      ]);
      }
    }
  }

  return {
    contactId,
    leadId,
    leadUrl: `https://${AMOCRM_SUBDOMAIN}.amocrm.ru/leads/detail/${leadId}`,
  };
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

/**
 * Helper to fetch custom field IDs (run once to see what fields are available)
 */
export async function getCustomFields() {
  try {
    const leadFields = await amoRequest('/leads/custom_fields', 'GET');
    const contactFields = await amoRequest('/contacts/custom_fields', 'GET');
    
    console.log('📋 Lead custom fields:', JSON.stringify(leadFields, null, 2));
    console.log('📋 Contact custom fields:', JSON.stringify(contactFields, null, 2));
    
    return { leadFields, contactFields };
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    throw error;
  }
}
