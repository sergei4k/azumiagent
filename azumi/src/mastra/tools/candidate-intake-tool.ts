import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createCandidateLead,
  searchCandidateInCRM,
  attachFilesToExistingLead,
  addNoteToLead,
} from '../integrations/amocrm';
import { getFileUrl } from '../integrations/telegram-client';
import { fileStoreByPhone } from '../integrations/shared-file-store';

// Helper to normalize phone numbers for comparison
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-\(\)\.]/g, '').replace(/^00/, '+');
}

// Tool to look up if a candidate already exists in the system
export const lookupCandidateTool = createTool({
  id: 'lookup-candidate',
  description: 'Check if a candidate already exists in our system by phone number, email, or name. Use this early in the conversation when a candidate provides their contact information to determine if they are new or returning.',
  inputSchema: z.object({
    phone: z.string().optional().describe('Phone number to search for'),
    email: z.string().email().optional().describe('Email address to search for'),
    fullName: z.string().optional().describe('Full name to search for (less reliable, use phone/email when possible)'),
  }).refine(
    (data) => data.phone || data.email || data.fullName,
    { message: 'At least one search parameter (phone, email, or name) must be provided' }
  ),
  outputSchema: z.object({
    found: z.boolean(),
    candidate: z.object({
      applicationId: z.string(),
      fullName: z.string(),
      phone: z.string(),
      email: z.string().optional(),
      status: z.string(),
      appliedAt: z.string(),
      lastContactAt: z.string(),
      notes: z.string().optional(),
    }).optional(),
    message: z.string(),
  }),
  execute: async ({ phone, email, fullName }) => {
    // Single source of truth: amoCRM stores all candidates and leads
    const crmResult = await searchCandidateInCRM({ phone, name: fullName, email });

    if (crmResult.found && crmResult.contact) {
      const contact = crmResult.contact;
      const latestLead = crmResult.leads[0]; // Most recent lead (sorted by date desc)

      const status = latestLead?.status || 'pending';
      const appliedAt = latestLead?.createdAt || new Date().toISOString();
      const applicationId = latestLead ? `AZM-${latestLead.id}` : `CRM-${contact.id}`;

      console.log(`🔍 Returning candidate (from amoCRM): ${contact.name} (${applicationId}), status: ${status}`);

      return {
        found: true,
        candidate: {
          applicationId,
          fullName: contact.name,
          phone: contact.phone || phone || '',
          email: contact.email,
          status,
          appliedAt,
          lastContactAt: new Date().toISOString(),
          notes: crmResult.leads.length > 1
            ? `${crmResult.leads.length} applications found in CRM. Latest status: ${status}`
            : undefined,
        },
        message: `Welcome back! Found existing application ${applicationId} for ${contact.name}, current status: ${status}`,
      };
    }

    console.log(`🔍 No existing candidate in amoCRM for: ${phone || fullName || email}`);
    return {
      found: false,
      candidate: undefined,
      message: 'No existing application found. This appears to be a new candidate.',
    };
  },
});

// Tool to submit candidate application for nanny/governess positions
export const submitCandidateApplicationTool = createTool({
  id: 'submit-candidate-application',
  description: 'Submit a candidate application when you have collected required information from a potential nanny/governess. Do not ask about years of experience or experience with children; collect basic details and qualifications only.',
  inputSchema: z.object({
    // Personal Information
    fullName: z.string().describe('Full legal name of the candidate'),
    phone: z.string().describe('Phone number with country code - PRIMARY CONTACT METHOD'),
    
    nationality: z.string().describe('Country of citizenship'),
    currentLocation: z.string().describe('Current city and country of residence'),
    dateOfBirth: z.string().optional().describe('Date of birth (optional)'),
    
    
    // Qualifications
    educationSummary: z.string().describe('Highest education level and relevant certifications'),
    specializations: z.array(z.string()).optional().describe('Special skills like newborn care, special needs, tutoring subjects, music, sports'),
    
    // Availability & Preferences
    availableFrom: z.string().describe('When candidate can start working'),
    preferredArrangement: z.enum(['live-in', 'live-out', 'flexible']).describe('Preferred living arrangement'),
    willingToRelocate: z.boolean().describe('Whether candidate is willing to relocate internationally'),
    preferredCountries: z.array(z.string()).optional().describe('Countries where candidate would like to work'),
    
    hasValidVisa: z.boolean().describe('Whether the candidate currently has a valid work visa for the country they want to work in'),
    visaDetails: z.string().optional().describe('Visa type and country it is valid for (e.g., "UK Tier 5 Youth Mobility", "UAE residence visa", "Schengen work permit"). Leave empty if no visa.'),
    
    // Documents & Media (file references from messaging platform or URLs)
    resumeFile: z.object({
      fileId: z.string().describe('File ID from messaging platform (WhatsApp, Telegram) or storage service'),
      fileName: z.string().optional().describe('Original file name'),
      fileType: z.string().optional().describe('MIME type (e.g., application/pdf, application/msword)'),
      fileUrl: z.string().url().optional().describe('Direct URL to the file if available'),
    }).optional().describe('Resume/CV file sent by candidate'),
    introVideoFile: z.object({
      fileId: z.string().describe('File ID from messaging platform or storage service'),
      fileName: z.string().optional().describe('Original file name'),
      fileType: z.string().optional().describe('MIME type (e.g., video/mp4)'),
      fileUrl: z.string().url().optional().describe('Direct URL to the video if available'),
      duration: z.number().optional().describe('Video duration in seconds if known'),
    }).optional().describe('2-3 minute self-introduction video file sent by candidate'),
    
    // Additional
    hasValidPassport: z.boolean().describe('Whether candidate has a valid passport'),
    additionalNotes: z.string().optional().describe('Any additional information from the conversation'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    applicationId: z.string(),
    message: z.string(),
    nextSteps: z.array(z.string()),
  }),
  execute: async (data) => {
    // Generate a unique application ID
    const applicationId = `AZM-${Date.now().toString(36).toUpperCase()}`;
    
    // Normalize phone number for file lookup
    const normalizedPhone = normalizePhone(data.phone);
    
    // Automatically inject files from file store if available
    let finalResumeFile = data.resumeFile;
    let finalIntroVideoFile = data.introVideoFile;
    
    const storedFiles = fileStoreByPhone.get(normalizedPhone);
    if (storedFiles) {
      // Use stored files if not provided in tool call
      if (!finalResumeFile && storedFiles.resumeFile) {
        finalResumeFile = storedFiles.resumeFile;
        console.log('📎 Auto-injected resume from file store (fileId=%s, fileUrl=%s)', storedFiles.resumeFile.fileId, storedFiles.resumeFile.fileUrl ? 'yes' : 'no');
      }
      if (!finalIntroVideoFile && storedFiles.introVideoFile) {
        finalIntroVideoFile = storedFiles.introVideoFile;
        console.log('📎 Auto-injected video from file store (fileId=%s, fileUrl=%s)', storedFiles.introVideoFile.fileId, storedFiles.introVideoFile.fileUrl ? 'yes' : 'no');
      }

      // Clean up after use
      fileStoreByPhone.delete(normalizedPhone);
    } else {
      console.warn('📎 No files in fileStoreByPhone for phone %s – files may not reach amoCRM', normalizedPhone);
    }
    
    // amoCRM is the single source of truth – no separate SQL save needed
    
    console.log('📝 New Candidate Application Received:');
    console.log(JSON.stringify({ ...data, resumeFile: finalResumeFile, introVideoFile: finalIntroVideoFile }, null, 2));

    // Resolve fileUrl from Telegram when we have fileId but no fileUrl (e.g. getFileUrl failed at store time)
    async function ensureFileUrl<T extends { fileId: string; fileUrl?: string }>(file: T | undefined, label: string): Promise<T | undefined> {
      if (!file) return undefined;
      if (file.fileUrl) return file;
      try {
        const url = await getFileUrl(file.fileId);
        console.log('📎 Resolved %s fileUrl from fileId %s', label, file.fileId);
        return { ...file, fileUrl: url };
      } catch (e) {
        console.warn('📎 Could not resolve %s fileUrl for fileId %s:', label, file.fileId, e);
        return file;
      }
    }
    const resumeForAmo = await ensureFileUrl(finalResumeFile, 'resume');
    const videoForAmo = await ensureFileUrl(finalIntroVideoFile, 'video');

    // Upload to amoCRM with files
    let amoResult;
    try {
      amoResult = await createCandidateLead({
        ...data,
        applicationId,
        preferredContactMethod: 'phone',
        resumeFile: resumeForAmo,
        introVideoFile: videoForAmo,
      });
      console.log('✅ Candidate uploaded to amoCRM:', amoResult.leadUrl);
    } catch (error) {
      console.error('❌ Failed to upload to amoCRM:', error);
      // Continue anyway - don't fail the application if CRM is down
    }
    
    const nextSteps = [
      'Our recruitment team will review your application within 2-3 business days',
    ];
    
    // Add reminders for missing documents
    if (!data.resumeFile) {
      nextSteps.push('Please send us your resume/CV when ready');
    }
    if (!data.introVideoFile) {
      nextSteps.push('Please record and send a 2-3 minute introduction video about yourself');
    }
    
    nextSteps.push(
      'Prepare your DBS/criminal background check documents',
      'Gather references from previous employers',
      'Have your educational certificates ready for verification',
    );
    
    return {
      success: true,
      applicationId,
      message: `Thank you, ${data.fullName}! Your application has been submitted successfully.`,
      nextSteps,
    };
  },
});

// Tool to check application requirements
export const checkRequirementsTool = createTool({
  id: 'check-requirements',
  description: 'Explain the requirements and documents needed for a specific type of position or country',
  inputSchema: z.object({
    positionType: z.enum(['nanny', 'governess', 'tutor', 'maternity-nurse']).describe('Type of position'),
    targetCountry: z.string().optional().describe('Country where candidate wants to work'),
  }),
  outputSchema: z.object({
    requirements: z.array(z.object({
      category: z.string(),
      items: z.array(z.string()),
      mandatory: z.boolean(),
    })),
  }),
  execute: async ({ positionType, targetCountry }) => {
    const baseRequirements = [
      {
        category: 'Background Check',
        items: [
          'Criminal background check (DBS check for UK)',
          'No history of child abuse or neglect',
          'Clean record regarding violence or drug offenses',
        ],
        mandatory: true,
      },
      {
        category: 'Documentation',
        items: [
          'Valid passport',
          'Work visa/permit for target country',
          'References from at least 2 previous employers',
        ],
        mandatory: true,
      },
      {
        category: 'Medical',
        items: [
          'HIV test (negative)',
          'Hepatitis B & C tests',
          'Syphilis test',
          'Fluorography/chest X-ray',
          'General health certificate',
        ],
        mandatory: true,
      },
      {
        category: 'Qualifications',
        items: [
          'Relevant childcare education or certification',
          'CPR certification (recommended)',
        ],
        mandatory: positionType === 'governess' || positionType === 'maternity-nurse',
      },
    ];


    return { requirements: baseRequirements };
  },
});

// Tool to schedule a callback with a recruiter
export const scheduleCallbackTool = createTool({
  id: 'schedule-callback',
  description: 'Schedule a callback with a human recruiter for candidates who want to speak with someone directly, or when they cannot provide required information and need human assistance',
  inputSchema: z.object({
    candidateName: z.string().describe('Name of the candidate'),
    phone: z.string().describe('Phone number to call'),
    email: z.string().email().optional().describe('Email for confirmation (optional)'),
    preferredTime: z.string().describe('Preferred time for callback (e.g., "tomorrow morning", "Wednesday 2pm Moscow time")'),
    timezone: z.string().describe('Candidate timezone'),
    topicOfDiscussion: z.string().optional().describe('What the candidate wants to discuss'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    confirmationDetails: z.string(),
  }),
  execute: async (data) => {
    // In production: integrate with calendar API (Google Calendar, Calendly, etc.)
    console.log('📞 Callback Request:', JSON.stringify(data, null, 2));
    
    const confirmationMethod = data.email 
      ? `A confirmation email has been sent to ${data.email}.`
      : 'You will receive a confirmation via phone/SMS.';
    
    return {
      success: true,
      message: `Callback scheduled for ${data.candidateName}`,
      confirmationDetails: `Our recruiter will call you at ${data.phone} during ${data.preferredTime} (${data.timezone}). ${confirmationMethod}`,
    };
  },
});

/** Parse lead ID from applicationId (e.g. AZM-123 → 123) */
function parseLeadIdFromApplicationId(applicationId: string): number | null {
  const m = applicationId.match(/^AZM-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

// Tool to attach new files (resume, video) to an existing candidate lead
export const attachFilesToExistingLeadTool = createTool({
  id: 'attach-files-to-existing-lead',
  description:
    'Attach new or updated resume and/or introduction video to an existing candidate application. Use when a RETURNING candidate (found via lookup-candidate) sends new files after their initial application. The files must be stored via the file store (candidate sent them in chat). Do NOT use for new candidates - use submit-candidate-application instead.',
  inputSchema: z.object({
    applicationId: z.string().describe('Application ID from lookup-candidate (e.g. AZM-123)'),
    phone: z.string().describe('Phone number used to store files in the file store'),
    candidateName: z.string().describe('Full name of the candidate'),
    noteText: z.string().optional().describe('Optional summary of what the candidate shared (e.g. "Updated resume with new certifications")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    attached: z.array(z.string()),
    message: z.string(),
  }),
  execute: async ({ applicationId, phone, candidateName, noteText }) => {
    const leadId = parseLeadIdFromApplicationId(applicationId);
    if (!leadId) {
      return { success: false, attached: [], message: `Invalid application ID: ${applicationId}. Expected format AZM-123.` };
    }

    const normalizedPhone = normalizePhone(phone);
    const storedFiles = fileStoreByPhone.get(normalizedPhone);
    if (!storedFiles || (!storedFiles.resumeFile && !storedFiles.introVideoFile)) {
      return {
        success: false,
        attached: [],
        message:
          'No files found for this phone number. Ask the candidate to send their resume or video directly in the chat, then try again.',
      };
    }

    async function ensureFileUrl<T extends { fileId: string; fileUrl?: string }>(
      file: T | undefined,
      label: string
    ): Promise<T | undefined> {
      if (!file) return undefined;
      if (file.fileUrl) return file;
      try {
        const url = await getFileUrl(file.fileId);
        return { ...file, fileUrl: url };
      } catch (e) {
        console.warn(`Could not resolve ${label} fileUrl:`, e);
        return file;
      }
    }

    const resumeForAmo = await ensureFileUrl(storedFiles.resumeFile, 'resume');
    const videoForAmo = await ensureFileUrl(storedFiles.introVideoFile, 'video');

    const { attached } = await attachFilesToExistingLead(
      leadId,
      { resumeFile: resumeForAmo, introVideoFile: videoForAmo },
      candidateName,
      noteText
    );

    fileStoreByPhone.delete(normalizedPhone);

    return {
      success: true,
      attached,
      message: attached.length > 0
        ? `Attached ${attached.join(', ')} to application ${applicationId}.`
        : 'No files with valid URLs were attached.',
    };
  },
});

// Tool to add a note with new info to an existing candidate lead
export const addNoteToCandidateLeadTool = createTool({
  id: 'add-note-to-candidate-lead',
  description:
    'Add a note with new information to an existing candidate application. Use when a RETURNING candidate (found via lookup-candidate) provides updated info such as: new visa status, changed availability, new certifications, updated contact details, or any other update that should be recorded in their application.',
  inputSchema: z.object({
    applicationId: z.string().describe('Application ID from lookup-candidate (e.g. AZM-123)'),
    noteText: z.string().describe('The new information to add (e.g. "Candidate now has UK Tier 5 visa valid until 2026")'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ applicationId, noteText }) => {
    const leadId = parseLeadIdFromApplicationId(applicationId);
    if (!leadId) {
      return { success: false, message: `Invalid application ID: ${applicationId}. Expected format AZM-123.` };
    }

    const header = `📝 Обновление от кандидата\n📅 ${new Date().toLocaleString('ru-RU')}\n\n${noteText}\n\n🤖 Источник: Telegram чат-бот`;
    await addNoteToLead(leadId, header);

    return { success: true, message: `Note added to application ${applicationId}.` };
  },
});
